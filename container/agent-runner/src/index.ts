/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  maxBudgetUsd?: number;
  threadTs?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  totalCostUsd?: number;
  /** Token-level usage breakdown computed from SDK result messages */
  tokenUsage?: TokenUsage;
  /** Cost computed from token counts using published Anthropic pricing */
  computedCostUsd?: number;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** Anthropic pricing per million tokens (April 2026). */
const OPUS_PRICING = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 };
const SONNET_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };
const HAIKU_PRICING = { input: 0.80, output: 4, cacheWrite: 1.00, cacheRead: 0.08 };

const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  // Claude 4.6 / 4 Opus family (including 1M context variants)
  'claude-opus-4-6-20250514':        OPUS_PRICING,
  'claude-opus-4-6':                 OPUS_PRICING,
  'claude-opus-4-20250514':          OPUS_PRICING,
  'claude-opus-4-0':                 OPUS_PRICING,
  // Claude 4.6 / 4 Sonnet family
  'claude-sonnet-4-6-20250514':      SONNET_PRICING,
  'claude-sonnet-4-6':               SONNET_PRICING,
  'claude-sonnet-4-20250514':        SONNET_PRICING,
  'claude-sonnet-4-0':               SONNET_PRICING,
  // Claude 3.5 family
  'claude-3-5-sonnet-20241022':      SONNET_PRICING,
  'claude-3-5-haiku-20241022':       HAIKU_PRICING,
};

/**
 * Fallback pricing if model is unknown — uses Sonnet rates as a conservative middle ground.
 * Over-reporting (Opus default) risks false alerts; under-reporting (Haiku) defeats the purpose.
 */
const DEFAULT_PRICING = SONNET_PRICING;
const warnedModels = new Set<string>();

function computeCostFromTokens(usage: TokenUsage, model?: string): number {
  let pricing = DEFAULT_PRICING;
  if (model) {
    const exact = MODEL_PRICING[model];
    if (exact) {
      pricing = exact;
    } else {
      // Try prefix matching for unknown variants (e.g. claude-opus-4-6-20260101)
      const prefix = model.includes('opus') ? OPUS_PRICING
        : model.includes('haiku') ? HAIKU_PRICING
        : model.includes('sonnet') ? SONNET_PRICING
        : null;
      if (prefix) {
        pricing = prefix;
      }
      if (!warnedModels.has(model)) {
        warnedModels.add(model);
        log(`Unknown model "${model}" — using ${prefix ? 'inferred' : 'default Sonnet'} pricing`);
      }
    }
  }
  const cost =
    (usage.inputTokens * pricing.input / 1_000_000) +
    (usage.outputTokens * pricing.output / 1_000_000) +
    (usage.cacheCreationInputTokens * pricing.cacheWrite / 1_000_000) +
    (usage.cacheReadInputTokens * pricing.cacheRead / 1_000_000);
  return cost;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

const IPC_COST_FILE = '/workspace/ipc/cost.json';

/**
 * Write accumulated cost to IPC file so the host can recover cost data
 * even if the container is killed (timeout, OOM, budget cap).
 */
function writeCostToIpc(costUsd: number, usage: TokenUsage): void {
  try {
    const data = JSON.stringify({
      costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      updatedAt: new Date().toISOString(),
    });
    // Atomic write: tmp + rename prevents partial reads on container kill
    const tmpFile = IPC_COST_FILE + '.tmp';
    fs.writeFileSync(tmpFile, data);
    fs.renameSync(tmpFile, IPC_COST_FILE);
  } catch {
    // Best-effort — IPC dir may not exist in tests
  }
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(groupFolder: string): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        // Only consume messages intended for this container's group
        if (data.groupFolder && data.groupFolder !== groupFolder) continue;
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(groupFolder: string): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput(groupFolder);
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput(containerInput.groupFolder);
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let detectedModel: string | undefined;
  // Accumulate token usage across all result messages in this query
  const accumulatedUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        'mcp__linear-server__*',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      ...(containerInput.maxBudgetUsd !== undefined
        ? { maxBudgetUsd: containerInput.maxBudgetUsd }
        : {}),
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            ...(containerInput.threadTs ? { NANOCLAW_THREAD_TS: containerInput.threadTs } : {}),
          },
        },
        ...(sdkEnv.LINEAR_API_KEY ? {
          'linear-server': {
            type: 'http' as const,
            url: 'https://mcp.linear.app/mcp',
            headers: { Authorization: `Bearer ${sdkEnv.LINEAR_API_KEY}` },
          },
        } : {}),
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      const initModel = (message as { model?: string }).model;
      if (initModel) detectedModel = initModel;
      log(`Session initialized: ${newSessionId}, model: ${detectedModel || 'unknown'}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      const sdkCost = 'total_cost_usd' in message ? (message as { total_cost_usd?: number }).total_cost_usd ?? 0 : 0;

      // Extract token usage from the result message's usage field
      const resultUsage = (message as { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }).usage;
      if (resultUsage) {
        // SDK result usage is cumulative within a query — take the latest (largest) values
        accumulatedUsage.inputTokens = Math.max(accumulatedUsage.inputTokens, resultUsage.input_tokens ?? 0);
        accumulatedUsage.outputTokens = Math.max(accumulatedUsage.outputTokens, resultUsage.output_tokens ?? 0);
        accumulatedUsage.cacheCreationInputTokens = Math.max(accumulatedUsage.cacheCreationInputTokens, resultUsage.cache_creation_input_tokens ?? 0);
        accumulatedUsage.cacheReadInputTokens = Math.max(accumulatedUsage.cacheReadInputTokens, resultUsage.cache_read_input_tokens ?? 0);
      }

      // Extract per-model usage breakdown (modelUsage field)
      const modelUsage = (message as { modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }> }).modelUsage;
      if (modelUsage) {
        // Use modelUsage for more accurate per-model cost calculation
        let modelComputedCost = 0;
        for (const [model, usage] of Object.entries(modelUsage)) {
          if (!detectedModel) detectedModel = model;
          const mu: TokenUsage = {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
          };
          modelComputedCost += computeCostFromTokens(mu, model);
        }
        if (modelComputedCost > 0) {
          const computedCost = modelComputedCost;
          log(`Result #${resultCount}: sdkCost=$${sdkCost.toFixed(4)}, computedCost=$${computedCost.toFixed(4)}, model=${detectedModel || 'unknown'}`);
          writeOutput({
            status: 'success',
            result: textResult || null,
            newSessionId,
            totalCostUsd: sdkCost,
            computedCostUsd: computedCost,
            tokenUsage: accumulatedUsage,
          });
          // Write cost to IPC for recovery on container kill
          writeCostToIpc(computedCost, accumulatedUsage);
          continue;
        }
      }

      // Fallback: compute from aggregate usage if modelUsage wasn't available
      const computedCost = computeCostFromTokens(accumulatedUsage, detectedModel);
      log(`Result #${resultCount}: sdkCost=$${sdkCost.toFixed(4)}, computedCost=$${computedCost.toFixed(4)} (fallback), model=${detectedModel || 'unknown'}`);
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
        totalCostUsd: sdkCost,
        computedCostUsd: computedCost > 0 ? computedCost : undefined,
        tokenUsage: resultUsage ? accumulatedUsage : undefined,
      });
      // Write cost to IPC for recovery on container kill
      if (computedCost > 0 || sdkCost > 0) {
        writeCostToIpc(computedCost > 0 ? computedCost : sdkCost, accumulatedUsage);
      }
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  if (containerInput.threadTs) {
    prompt = `[THREAD CONTEXT: This message was sent in a Slack thread (thread_ts: ${containerInput.threadTs}). When using the send_message tool for progress updates, pass thread_ts="${containerInput.threadTs}" so replies stay in the thread.]\n\n${prompt}`;
  }
  const pending = drainIpcInput(containerInput.groupFolder);
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage(containerInput.groupFolder);
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);

    // Detect budget/credit exhaustion and notify the channel before exiting
    const isBudgetError = /budget|credit|billing|payment|quota|limit exceeded|overloaded|529|402/i.test(errorMessage);
    if (isBudgetError) {
      try {
        const messagesDir = '/workspace/ipc/messages';
        fs.mkdirSync(messagesDir, { recursive: true });
        const filename = `${Date.now()}-budget-exhausted.json`;
        const payload = {
          type: 'message',
          chatJid: containerInput.chatJid,
          text: `Budget exhausted — cannot process this task. Task: ${containerInput.prompt.slice(0, 120)}${containerInput.prompt.length > 120 ? '…' : ''}. Retry after limit resets.`,
          groupFolder: containerInput.groupFolder,
          timestamp: new Date().toISOString(),
        };
        const tmp = `${messagesDir}/${filename}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
        fs.renameSync(tmp, `${messagesDir}/${filename}`);
        log('Budget exhaustion notification written to IPC messages');
      } catch (notifyErr) {
        log(`Failed to write budget notification: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`);
      }
    }

    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
