import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_MAX_BUDGET_USD,
  IDLE_TIMEOUT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  appendCostLog,
  getCostSummary,
  getAndClearInFlightTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  deleteSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

/** @internal — exported for testing only */
export { runAgent as _runAgent };

/**
 * Select the message whose ID should be used as thread_ts for replies.
 * Main groups: latest message (all messages trigger processing).
 * Non-main groups: latest message matching the trigger pattern + allowlist.
 * @internal — exported for testing
 */
export function selectThreadMessage(
  messages: NewMessage[],
  isMain: boolean,
  chatJid: string,
  triggerPattern: RegExp,
  allowlistChecker: (
    chatJid: string,
    sender: string,
    cfg: ReturnType<typeof loadSenderAllowlist>,
  ) => boolean,
  allowlistLoader: () => ReturnType<typeof loadSenderAllowlist>,
): NewMessage | undefined {
  if (messages.length === 0) return undefined;
  if (isMain) return messages[messages.length - 1];
  const cfg = allowlistLoader();
  return [...messages]
    .reverse()
    .find(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || allowlistChecker(chatJid, m.sender, cfg)),
    );
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
const latestThreadTs: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  const threadMsg = selectThreadMessage(
    missedMessages,
    isMainGroup,
    chatJid,
    TRIGGER_PATTERN,
    isTriggerAllowed,
    loadSenderAllowlist,
  );
  const threadTs = threadMsg?.id;
  if (threadTs) latestThreadTs[chatJid] = threadTs;

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          await channel.sendMessage(
            chatJid,
            text,
            latestThreadTs[chatJid] || threadTs
              ? { threadTs: latestThreadTs[chatJid] || threadTs }
              : undefined,
          );
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    threadTs,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // If the task was cancelled by the user, don't roll back — the user
    // intentionally stopped this work. Rolling back would respawn it.
    if (queue.wasCancelled(chatJid)) {
      // Clear session so next interaction starts fresh, not resuming cancelled work
      delete sessions[group.folder];
      deleteSession(group.folder);
      logger.info(
        { group: group.name },
        'Task was cancelled by user, session cleared, skipping cursor rollback',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

function isStaleSessionError(error?: string): boolean {
  if (!error) return false;
  return (
    error.includes('No conversation found') ||
    error.includes('session_not_found')
  );
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  threadTs?: string,
  retryCount = 0,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        threadTs,
        maxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
      },
      (proc, containerName, resetTimeout) =>
        queue.registerProcess(
          chatJid,
          proc,
          containerName,
          group.folder,
          resetTimeout,
        ),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Stale session recovery: clear session and retry once
      if (isStaleSessionError(output.error) && retryCount < 1) {
        logger.warn(
          { group: group.name, error: output.error },
          'Stale session detected, clearing and retrying',
        );
        // Clear both in-memory and persisted session
        delete sessions[group.folder];
        deleteSession(group.folder);
        // Warn user via Slack thread
        const channel = findChannel(channels, chatJid);
        if (channel && threadTs) {
          await channel.sendMessage(
            chatJid,
            'Session expired, starting fresh',
            {
              threadTs,
            },
          );
        }
        // Retry with fresh session (no sessionId)
        return runAgent(
          group,
          prompt,
          chatJid,
          onOutput,
          threadTs,
          retryCount + 1,
        );
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      // Still log cost on error — a killed/failed container still consumed API tokens
    }

    // Track cost if reported (runs for both success and error)
    logger.debug(
      { group: group.name, totalCostUsd: output.totalCostUsd ?? null },
      'Agent run cost data',
    );
    if ((output.totalCostUsd ?? 0) > 0) {
      try {
        appendCostLog(group.folder, chatJid, output.totalCostUsd!);
        const summary = getCostSummary(group.folder);
        const groupDir = resolveGroupFolderPath(group.folder);
        const costSummaryPath = path.join(groupDir, 'cost-summary.json');
        fs.writeFileSync(
          costSummaryPath,
          JSON.stringify(
            {
              today_usd: summary.todayUsd,
              week_usd: summary.weekUsd,
              all_time_usd: summary.allTimeUsd,
              last_updated: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        logger.debug(
          { group: group.name, costUsd: output.totalCostUsd },
          'Cost logged and summary written',
        );
      } catch (err) {
        logger.warn({ group: group.name, err }, 'Failed to write cost summary');
      }
    }

    return output.status === 'error' ? 'error' : 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          const pipedThreadMsg = selectThreadMessage(
            messagesToSend,
            isMainGroup,
            chatJid,
            TRIGGER_PATTERN,
            isTriggerAllowed,
            loadSenderAllowlist,
          );
          if (pipedThreadMsg) latestThreadTs[chatJid] = pipedThreadMsg.id;
          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    queue,
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Cancel command — intercept before storing as a task message
      const lowerTrimmed = trimmed.toLowerCase();
      if (TRIGGER_PATTERN.test(trimmed) && lowerTrimmed.endsWith('cancel')) {
        const success = queue.forceStopGroup(chatJid);
        const ch = findChannel(channels, chatJid);
        if (success) {
          ch?.sendMessage(
            chatJid,
            'Cancelling task... Agent has 15 seconds to commit work before hard stop.',
          )?.catch((err: unknown) =>
            logger.error({ err, chatJid }, 'Cancel ack send error'),
          );
        } else {
          ch?.sendMessage(
            chatJid,
            'No active task to cancel in this channel.',
          )?.catch((err: unknown) =>
            logger.error({ err, chatJid }, 'Cancel ack send error'),
          );
        }
        return; // Do NOT fall through to storeMessage
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        registeredGroups[chatJid] &&
        TRIGGER_PATTERN.test(msg.content.trim())
      ) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      // Fire-and-forget emoji reaction on inbound non-bot messages before storing
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        registeredGroups[chatJid] &&
        TRIGGER_PATTERN.test(msg.content.trim())
      ) {
        const ch = findChannel(channels, chatJid);
        ch?.reactToMessage?.(chatJid, msg.id, 'eyes')?.catch((err) =>
          logger.debug({ err }, 'Failed to add eyes reaction'),
        );
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Notify about any tasks that were interrupted by a restart
  const interrupted = getAndClearInFlightTasks();
  if (interrupted.length > 0) {
    const byChannel = new Map<string, typeof interrupted>();
    for (const task of interrupted) {
      const key = task.group_folder + ':' + task.channel_id;
      if (!byChannel.has(key)) byChannel.set(key, []);
      byChannel.get(key)!.push(task);
    }
    for (const [, tasks] of byChannel) {
      const { group_folder, channel_id } = tasks[0];
      const jid = Object.keys(registeredGroups).find(
        (j) => registeredGroups[j].folder === group_folder,
      );
      const ch = jid ? findChannel(channels, jid) : null;
      if (ch) {
        const channelJid = ch.name + ':' + channel_id;
        const taskList = tasks
          .map((t) => {
            const msg = t.original_message || '';
            // Extract ALL messages from XML
            const allMatches = [
              ...msg.matchAll(
                /<message\s+sender="([^"]*)"\s+time="([^"]*)"[^>]*>([\s\S]*?)<\/message>/g,
              ),
            ];
            // Clean a raw message: strip mentions, angle brackets, whitespace
            const cleanMsg = (s: string) =>
              s
                .replace(/&lt;@[A-Z0-9]+&gt;/g, '')
                .replace(/<@[A-Z0-9]+>/g, '')
                .replace(/@\S+\s*/g, '')
                .replace(
                  /&lt;|&gt;|&quot;|&amp;/g,
                  (m: string) =>
                    ({ '&lt;': '<', '&gt;': '>', '&quot;': '"', '&amp;': '&' })[
                      m
                    ] || m,
                )
                .replace(/^[<>\s]+|[<>\s]+$/g, '')
                .trim();
            // Find the last substantive message (>15 chars, skip 'continue' etc)
            let bestMatch: {
              sender: string;
              time: string;
              content: string;
            } | null = null;
            for (let i = allMatches.length - 1; i >= 0; i--) {
              const cleaned = cleanMsg(allMatches[i][3]);
              if (cleaned.length > 15) {
                bestMatch = {
                  sender: allMatches[i][1],
                  time: allMatches[i][2],
                  content: cleaned,
                };
                break;
              }
            }
            // If no substantive message found, use first message but label appropriately
            if (!bestMatch && allMatches.length > 0) {
              const m = allMatches[allMatches.length - 1];
              const cleaned = cleanMsg(m[3]);
              bestMatch = {
                sender: m[1],
                time: m[2],
                content: cleaned || 'Resumed task',
              };
            }
            if (bestMatch) {
              let content = bestMatch.content;
              if (content.length > 100) content = content.slice(0, 97) + '...';
              return (
                '\u2022 *' +
                bestMatch.sender +
                '* at ' +
                bestMatch.time +
                ': `' +
                content +
                '`'
              );
            }
            // Fallback: strip all tags and formatting artifacts
            const clean = msg
              .replace(/<[^>]+>/g, '')
              .replace(/^[<>\s]+|[<>\s]+$/g, '')
              .trim();
            return (
              '\u2022 ' +
              (clean.length > 100
                ? '`' + clean.slice(0, 97) + '...`'
                : '`' + (clean || 'Unknown task') + '`')
            );
          })
          .join('\n');
        const count = tasks.length === 1 ? 'a task' : tasks.length + ' tasks';
        ch.sendMessage(
          channelJid,
          'I was restarted while working on ' +
            count +
            '.\n\n' +
            taskList +
            '\n\nProgress is saved \u2014 check git log on any feature branches. Reply @' +
            ASSISTANT_NAME +
            ' continue to resume, or re-send your request.',
        ).catch((err) =>
          logger.warn(
            { tasks, err },
            'Failed to send interrupted task notification',
          ),
        );
      }
      logger.info(
        { group_folder, taskCount: tasks.length },
        'Notified interrupted tasks',
      );
    }
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text, opts) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      // Use the latest trigger message ts for threading (overrides stale container-baked ts)
      const threadOpts = latestThreadTs[jid]
        ? { ...opts, threadTs: latestThreadTs[jid] }
        : opts;
      return channel.sendMessage(jid, text, threadOpts);
    },
    injectMessage: (chatJid, text, senderName) => {
      const ts = String(Date.now() / 1000);
      const rand = Math.random().toString(36).slice(2, 8);
      storeMessage({
        id: `ipc-${ts}-${rand}`,
        chat_jid: chatJid,
        sender: 'ipc',
        sender_name: senderName,
        content: text,
        timestamp: ts,
        // is_from_me=true so the trigger sender check passes without
        // requiring 'ipc' in the sender allowlist.
        // is_bot_message=false so getNewMessages includes this row
        // (its WHERE clause requires is_bot_message = 0, excluding bot messages).
        is_from_me: true,
        is_bot_message: false,
      });
      queue.enqueueMessageCheck(chatJid);
    },
    uploadFile: async (params) => {
      const channel = channels.find((ch) => ch.uploadFile);
      if (!channel?.uploadFile)
        throw new Error('No channel supports file upload');
      return channel.uploadFile(params);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  queue.setOnMessageQueued((groupJid) => {
    // Don't send "Queued" for isMain groups — they process all messages
    // inline via piped stdin. The message isn't actually queued; the
    // running container will receive it. Sending "Queued" is misleading.
    const group = registeredGroups[groupJid];
    if (group?.isMain) return;

    const channel = findChannel(channels, groupJid);
    if (!channel) return;
    // Reply in the current thread so the notification is contextual,
    // not a disruptive channel-level message.
    const threadTs = latestThreadTs[groupJid];
    channel
      .sendMessage(
        groupJid,
        "Queued — I'm working on something else in this channel. You're next.",
        threadTs ? { threadTs } : undefined,
      )
      .catch((err) =>
        logger.warn({ groupJid, err }, 'Failed to send queue acknowledgment'),
      );
  });
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
