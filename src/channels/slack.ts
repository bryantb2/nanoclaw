import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { execSync } from 'child_process';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import {
  updateChatName,
  isIpcInjectedMessage,
  getInFlightTasksList,
  getAllTasks,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import type { GroupQueue } from '../group-queue.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
/**
 * Convert GitHub-flavored markdown to Slack mrkdwn.
 */
function markdownToSlackMrkdwn(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/```\w*\n/g, '```\n')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/^(\s*)- /gm, '$1\u2022 ')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
}
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

// --- Slash command helpers ---

/**
 * Format elapsed seconds as human-readable duration: "3m 24s", "1h 5m", "2d 3h"
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSecs = seconds % 60;
  if (minutes < 60)
    return remainSecs > 0 ? `${minutes}m ${remainSecs}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  if (hours < 24)
    return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
}

/**
 * Format the /tasks compact table.
 * Cross-references active container list with in-flight task rows for duration.
 */
function formatTasksTable(
  active: Array<{
    groupJid: string;
    containerName: string;
    groupFolder: string;
    isTaskContainer: boolean;
    runningTaskId: string | null;
  }>,
  inFlight: Array<{
    id: number;
    group_folder: string;
    channel_id: string;
    thread_ts: string | null;
    original_message: string | null;
    started_at?: string;
  }>,
): string {
  if (active.length === 0) return 'No tasks running.';

  // Build lookup: groupFolder -> inFlight row
  const byFolder = new Map(inFlight.map((t) => [t.group_folder, t]));

  const lines: string[] = ['*Running Agents*', '```'];
  lines.push(
    'Group           Duration   Message Preview                   Container',
  );
  lines.push('─'.repeat(80));

  for (const a of active) {
    const row = byFolder.get(a.groupFolder);
    let duration = '?';
    if (row?.started_at) {
      // SQLite datetime('now') stores UTC without 'Z' suffix — append it
      const startMs = new Date(row.started_at + 'Z').getTime();
      const elapsedSec = Math.floor((Date.now() - startMs) / 1000);
      duration = formatDuration(Math.max(0, elapsedSec));
    }
    // Extract user message from XML context wrapper, strip mentions
    const rawMsg = row?.original_message ?? '';
    const msgMatch = rawMsg.match(
      /<message\s+sender="[^"]*"[^>]*>([\s\S]*?)<\/message>/,
    );
    const cleanMsg = (msgMatch ? msgMatch[1] : rawMsg)
      .replace(/&lt;@[A-Z0-9]+&gt;/g, '')
      .replace(/<@[A-Z0-9]+>/g, '')
      .replace(/@\S+\s*/g, '')
      .replace(
        /&lt;|&gt;|&quot;|&amp;/g,
        (m: string) =>
          ({ '&lt;': '<', '&gt;': '>', '&quot;': '"', '&amp;': '&' })[m] || m,
      )
      .replace(/^[<>\s]+|[<>\s]+$/g, '')
      .trim();
    const preview = cleanMsg.slice(0, 50);
    const group = a.groupFolder.padEnd(16).slice(0, 16);
    const dur = duration.padEnd(11).slice(0, 11);
    const msg = preview.padEnd(34).slice(0, 34);
    lines.push(`${group}${dur}${msg}${a.containerName}`);
  }

  lines.push('```');
  return lines.join('\n');
}

/**
 * Format the /scheduled compact table.
 */
function formatScheduledTable(
  tasks: Array<{
    id: string;
    group_folder: string;
    schedule_type: string;
    schedule_value: string;
    next_run: string | null;
  }>,
): string {
  if (tasks.length === 0) return 'No scheduled tasks.';

  const lines: string[] = ['*Scheduled Tasks*', '```'];
  lines.push('ID              Group           Schedule        Next Run (MT)');
  lines.push('─'.repeat(72));

  for (const t of tasks) {
    const nextRunMt = t.next_run
      ? new Date(t.next_run).toLocaleString('en-US', {
          timeZone: 'America/Denver',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        })
      : 'pending';

    const id = t.id.slice(0, 16).padEnd(16);
    const group = t.group_folder.padEnd(16).slice(0, 16);
    const schedule = t.schedule_value.padEnd(16).slice(0, 16);
    lines.push(`${id}${group}${schedule}${nextRunMt}`);
  }

  lines.push('```');
  return lines.join('\n');
}

/**
 * Format process.uptime() as "Xd Xh Xm Xs"
 */
function formatUptime(uptimeSec: number): string {
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${Math.floor(uptimeSec % 60)}s`);
  return parts.join(' ');
}

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue?: GroupQueue;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      // Option B race guard: Slack echoes the bot's own messages back via
      // this webhook. When IPC routing already injected a row at (msg.ts,
      // jid) with origin='ipc', re-ingesting the echo as a bot message
      // would INSERT OR REPLACE the IPC row with is_bot_message=1 — which
      // getNewMessages filters out, silently dropping the dispatched
      // trigger. The guard lives here (in the Slack adapter) instead of
      // in the channel-agnostic onMessage callback because the race is
      // 100% a Slack Events API quirk; Telegram/Discord/etc. have no
      // such echo behavior.
      if (isBotMessage && isIpcInjectedMessage(msg.ts, jid)) {
        logger.debug(
          { jid, ts: msg.ts },
          'Slack bot echo skipped: row already owned by IPC injection',
        );
        return;
      }

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
        origin: 'webhook',
      });
    });

    // --- Slash command handlers ---
    // ack() is always called first (before any data reads) to beat the 3-second Slack window.
    // All reads are synchronous SQLite or Map lookups (<1ms each).

    this.app.command('/tasks', async ({ ack, respond }) => {
      await ack();
      const active = this.opts.queue?.getActiveState() ?? [];
      const inFlight = getInFlightTasksList();
      const text = formatTasksTable(active, inFlight);
      await respond({ response_type: 'ephemeral', text });
    });

    this.app.command('/fleet-status', async ({ ack, respond }) => {
      await ack();
      const uptimeSec = Math.floor(process.uptime());
      const containerCount = this.opts.queue?.getActiveCount() ?? 0;

      let diskUsage = 'unavailable';
      try {
        const dfOut = execSync('df -h / | tail -1', {
          encoding: 'utf8',
          timeout: 2000,
        });
        const parts = dfOut.trim().split(/\s+/);
        // df -h columns: Filesystem, Size, Used, Avail, Use%, Mounted
        if (parts.length >= 5) {
          diskUsage = `${parts[2]} used of ${parts[1]} (${parts[4]})`;
        }
      } catch {
        // Not in a Docker environment or df unavailable
      }

      let onecliStatus = 'not running';
      try {
        const resp = execSync(
          'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:10254/api/secrets',
          { encoding: 'utf8', stdio: 'pipe', timeout: 2000 },
        );
        onecliStatus = resp.trim() === '200' ? 'connected' : 'error';
      } catch {
        // OneCLI not reachable
      }

      const text = [
        '*NanoClaw Status*',
        `• Uptime: ${formatUptime(uptimeSec)}`,
        `• Active containers: ${containerCount}`,
        `• Disk: ${diskUsage}`,
        `• OneCLI: ${onecliStatus}`,
      ].join('\n');

      await respond({ response_type: 'ephemeral', text });
    });

    this.app.command('/scheduled', async ({ ack, respond }) => {
      await ack();
      const allTasks = getAllTasks();
      const activeTasks = allTasks.filter(
        (t) => t.status === 'active' && t.next_run,
      );
      const text = formatScheduledTable(activeTasks);
      await respond({ response_type: 'ephemeral', text });
    });

    this.app.command('/cancel', async ({ ack, respond, command }) => {
      await ack();
      const text = command.text?.trim();
      const queue = this.opts.queue;
      if (!queue) {
        await respond({
          response_type: 'ephemeral',
          text: 'Queue not available.',
        });
        return;
      }

      // If taskId provided, find the group for that task.
      // Otherwise, find the group for the invoking channel.
      const active = queue.getActiveState();
      const target = text
        ? active.find((a) => a.runningTaskId === text)
        : active.find((a) => a.groupJid.includes(command.channel_id));

      if (!target) {
        await respond({
          response_type: 'ephemeral',
          text: 'No task running in this channel.',
        });
        return;
      }

      const success = queue.forceStopGroup(target.groupJid);
      if (success) {
        await respond({
          response_type: 'ephemeral',
          text: `Cancelling task in ${target.groupFolder}... (15s grace period)`,
        });
      } else {
        await respond({
          response_type: 'ephemeral',
          text: 'Failed to cancel — container may have already stopped.',
        });
      }
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: { threadTs?: string },
  ): Promise<string | undefined> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return undefined;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed.
      // When splitting, return the FIRST chunk's ts — subsequent replies
      // thread under the first message (which is where users land when
      // clicking the thread in their client).
      //
      // The Slack SDK normally throws on errors, but some failure modes
      // (e.g. `not_in_channel`, `channel_not_found`, `is_archived`) can
      // resolve with `{ ok: false, error: '...' }` instead. Treat those
      // as failures so we don't (a) return `undefined` masquerading as
      // success and (b) silently anchor IPC threading on a later chunk's
      // ts when the first chunk soft-failed.
      let firstTs: string | undefined;
      const post = async (chunk: string): Promise<string | undefined> => {
        const resp = await this.app.client.chat.postMessage({
          channel: channelId,
          text: markdownToSlackMrkdwn(chunk),
          ...(opts?.threadTs ? { thread_ts: opts.threadTs } : {}),
        });
        if (!resp.ok || !resp.ts) {
          throw new Error(
            `Slack chat.postMessage soft-failed: ${resp.error ?? 'unknown'}`,
          );
        }
        return resp.ts;
      };
      if (text.length <= MAX_MESSAGE_LENGTH) {
        firstTs = await post(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          const ts = await post(text.slice(i, i + MAX_MESSAGE_LENGTH));
          if (firstTs === undefined) firstTs = ts;
        }
      }
      logger.info(
        { jid, length: text.length, ts: firstTs },
        'Slack message sent',
      );
      return firstTs;
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
      return undefined;
    }
  }

  async reactToMessage(
    channelId: string,
    messageTs: string,
    emoji: string,
  ): Promise<void> {
    const rawChannelId = channelId.replace(/^slack:/, '');
    await this.app.client.reactions.add({
      channel: rawChannelId,
      name: emoji,
      timestamp: messageTs,
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: markdownToSlackMrkdwn(item.text),
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }

  async uploadFile(params: {
    channelId: string;
    filePath: string;
    threadTs?: string;
    title?: string;
    comment?: string;
  }): Promise<void> {
    const { default: fs } = await import('fs');
    const fileContent = fs.readFileSync(params.filePath);
    const fileName = params.filePath.split('/').pop() ?? 'file';

    // Step 1: get upload URL
    const urlResp = await this.app.client.files.getUploadURLExternal({
      filename: fileName,
      length: fileContent.length,
      ...(params.title ? { title: params.title } : {}),
    });
    if (!urlResp.ok || !urlResp.upload_url || !urlResp.file_id) {
      throw new Error(`getUploadURLExternal failed: ${urlResp.error}`);
    }

    // Step 2: upload the file bytes
    await fetch(urlResp.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fileContent,
    });

    // Step 3: complete the upload
    await this.app.client.files.completeUploadExternal({
      files: [{ id: urlResp.file_id, title: params.title ?? fileName }],
      channel_id: params.channelId,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
      ...(params.comment ? { initial_comment: params.comment } : {}),
    });

    logger.info(
      { channelId: params.channelId, filePath: params.filePath },
      'File uploaded to Slack',
    );
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
