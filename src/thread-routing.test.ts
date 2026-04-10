import { describe, it, expect, vi } from 'vitest';
import type { NewMessage } from './types.js';

// Mock all dependencies before importing the module under test
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Fleet',
  CONTAINER_IMAGE: 'test',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/test',
  GROUPS_DIR: '/tmp/test-groups',
  IDLE_TIMEOUT: 1800000,
  ONECLI_URL: 'http://localhost:10254',
  POLL_INTERVAL: 1000,
  TIMEZONE: 'America/Denver',
  TRIGGER_PATTERN: /^@Fleet\b/i,
  DEFAULT_MAX_BUDGET_USD: 5,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('./db.js', () => ({
  deleteSession: vi.fn(),
  setSession: vi.fn(),
  getSession: vi.fn(() => undefined),
  appendCostLog: vi.fn(),
  getCostSummary: vi.fn(() => ({ todayUsd: 0, weekUsd: 0, allTimeUsd: 0 })),
  getAllSessions: vi.fn(() => ({})),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getAllChats: vi.fn(() => []),
  getAllTasks: vi.fn(() => []),
  getMessagesSince: vi.fn(() => []),
  getNewMessages: vi.fn(() => []),
  getRouterState: vi.fn(() => null),
  setRouterState: vi.fn(),
  initDatabase: vi.fn(),
  setRegisteredGroup: vi.fn(),
  storeChatMetadata: vi.fn(),
  storeMessage: vi.fn(),
  getAndClearInFlightTasks: vi.fn(() => []),
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => '/tmp/test'),
  resolveGroupIpcPath: vi.fn(() => '/tmp/test-ipc'),
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: vi.fn(() => []),
  readonlyMountArgs: vi.fn((...args: unknown[]) => [
    '-v',
    `${args[0]}:${args[1]}:ro`,
  ]),
  stopContainer: vi.fn(() => 'docker stop test'),
  ensureContainerRuntimeRunning: vi.fn(),
}));

vi.mock('./remote-control.js', () => ({
  restoreRemoteControl: vi.fn(),
  startRemoteControl: vi.fn(),
  stopRemoteControl: vi.fn(),
}));

vi.mock('./sender-allowlist.js', () => ({
  isSenderAllowed: vi.fn(() => true),
  isTriggerAllowed: vi.fn(() => true),
  loadSenderAllowlist: vi.fn(() => ({
    default: { allow: '*', mode: 'trigger' },
    chats: {},
  })),
  shouldDropMessage: vi.fn(() => false),
}));

vi.mock('./task-scheduler.js', () => ({
  startSchedulerLoop: vi.fn(),
}));

vi.mock('./ipc.js', () => ({
  startIpcWatcher: vi.fn(() => () => {}),
}));

vi.mock('./router.js', () => ({
  findChannel: vi.fn(() => ({
    ownsJid: vi.fn(() => true),
    isConnected: vi.fn(() => true),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  })),
  formatMessages: vi.fn(() => '<messages></messages>'),
  formatOutbound: vi.fn((s: string) => s),
  escapeXml: vi.fn((s: string) => s),
}));

vi.mock('./group-queue.js', () => ({
  GroupQueue: class {
    enqueue = vi.fn();
    registerProcess = vi.fn();
    wasCancelled = vi.fn(() => false);
    getActiveState = vi.fn(() => ({}));
    getActiveCount = vi.fn(() => 0);
    on = vi.fn();
  },
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    ensureAgent = vi.fn().mockResolvedValue({ created: false });
  },
}));

import { selectThreadMessage } from './index.js';

// --- Helpers ---

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: 'slack:C0APW8L9V6E',
    sender: 'U0982HUBQ56',
    sender_name: 'Blake',
    content: 'Hello',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const TRIGGER_PATTERN = /^@Fleet\b/i;
const alwaysAllowed = () => true;
const neverAllowed = () => false;
const noopLoader = () => ({}) as any;

// --- Tests ---

describe('selectThreadMessage — thread routing', () => {
  describe('main groups (isMain: true)', () => {
    it('uses the latest message regardless of trigger pattern', () => {
      const msg1 = makeMessage({ id: 'old-msg', content: 'no trigger here' });
      const msg2 = makeMessage({ id: 'new-msg', content: 'also no trigger' });

      const result = selectThreadMessage(
        [msg1, msg2],
        true,
        'slack:C123',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result?.id).toBe('new-msg');
    });

    it('uses the latest message even when earlier messages have triggers', () => {
      const trigger = makeMessage({
        id: 'trigger-msg',
        content: '@Fleet do stuff',
      });
      const noTrigger = makeMessage({
        id: 'latest-msg',
        content: 'The dev-team agent finished PR #88',
      });

      const result = selectThreadMessage(
        [trigger, noTrigger],
        true,
        'slack:C123',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result?.id).toBe('latest-msg');
    });

    it('returns the single message when only one is present', () => {
      const msg = makeMessage({
        id: 'only-msg',
        content: 'Hand this off to QA',
      });

      const result = selectThreadMessage(
        [msg],
        true,
        'slack:C123',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result?.id).toBe('only-msg');
    });

    it('returns undefined for empty messages', () => {
      const result = selectThreadMessage(
        [],
        true,
        'slack:C123',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result).toBeUndefined();
    });

    it('does NOT call the allowlist loader (no trigger check needed)', () => {
      const loader = vi.fn(() => ({}) as any);
      const msg = makeMessage({ content: 'hello' });

      selectThreadMessage(
        [msg],
        true,
        'slack:C123',
        TRIGGER_PATTERN,
        alwaysAllowed,
        loader,
      );
      expect(loader).not.toHaveBeenCalled();
    });
  });

  describe('non-main groups (isMain: false)', () => {
    it('uses the latest trigger message', () => {
      const noTrigger = makeMessage({ id: 'context', content: 'some context' });
      const trigger = makeMessage({
        id: 'trigger',
        content: '@Fleet build KRE-199',
      });

      const result = selectThreadMessage(
        [noTrigger, trigger],
        false,
        'slack:C123',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result?.id).toBe('trigger');
    });

    it('uses the LATEST trigger when multiple triggers exist', () => {
      const old = makeMessage({ id: 'old-trigger', content: '@Fleet do X' });
      const mid = makeMessage({ id: 'context', content: 'some context' });
      const latest = makeMessage({ id: 'new-trigger', content: '@Fleet do Y' });

      const result = selectThreadMessage(
        [old, mid, latest],
        false,
        'slack:C123',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result?.id).toBe('new-trigger');
    });

    it('returns undefined when no messages match the trigger pattern', () => {
      const msg1 = makeMessage({ content: 'no trigger' });
      const msg2 = makeMessage({ content: 'also no trigger' });

      const result = selectThreadMessage(
        [msg1, msg2],
        false,
        'slack:C123',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result).toBeUndefined();
    });

    it('skips trigger messages from non-allowlisted senders', () => {
      const blocked = makeMessage({
        id: 'blocked',
        content: '@Fleet hack the planet',
        sender: 'UBAD',
      });
      const allowed = makeMessage({
        id: 'allowed',
        content: '@Fleet deploy',
        sender: 'UGOOD',
      });

      const checker = (_jid: string, sender: string) => sender === 'UGOOD';

      const result = selectThreadMessage(
        [blocked, allowed],
        false,
        'slack:C123',
        TRIGGER_PATTERN,
        checker as any,
        noopLoader,
      );
      expect(result?.id).toBe('allowed');
    });

    it('allows trigger messages from self (is_from_me)', () => {
      const selfMsg = makeMessage({
        id: 'self-trigger',
        content: '@Fleet check status',
        is_from_me: true,
      });

      const result = selectThreadMessage(
        [selfMsg],
        false,
        'slack:C123',
        TRIGGER_PATTERN,
        neverAllowed,
        noopLoader,
      );
      expect(result?.id).toBe('self-trigger');
    });

    it('returns undefined for empty messages', () => {
      const result = selectThreadMessage(
        [],
        false,
        'slack:C123',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result).toBeUndefined();
    });
  });

  describe('real-world scenarios', () => {
    it('dispatch (main): fresh channel message gets threaded correctly', () => {
      // Simulates the exact bug: user sends non-trigger message to main group
      const msg = makeMessage({
        id: '1775276573.357499',
        content:
          'The dev-team agent just finished up the initial implementation for this PR: https://github.com/Krewtrack/forcify/pull/88',
      });

      const result = selectThreadMessage(
        [msg],
        true,
        'slack:C0APW8L9V6E',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      // Should use this message as thread, NOT fall through to stale
      expect(result?.id).toBe('1775276573.357499');
    });

    it('dev-team (non-main): @Fleet trigger gets threaded correctly', () => {
      const context = makeMessage({
        id: 'context-1',
        content: 'Here is some background',
      });
      const trigger = makeMessage({
        id: '1775267637.441379',
        content: '@Fleet work on KRE-199',
      });

      const result = selectThreadMessage(
        [context, trigger],
        false,
        'slack:C0ANT2AL2AY',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result?.id).toBe('1775267637.441379');
    });

    it('dev-team (non-main): message without @Fleet is not used as thread anchor', () => {
      const noTrigger = makeMessage({
        id: 'should-not-anchor',
        content: 'Just FYI the build is broken',
      });

      const result = selectThreadMessage(
        [noTrigger],
        false,
        'slack:C0ANT2AL2AY',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result).toBeUndefined();
    });
  });

  describe('synthetic ipc- ID filtering', () => {
    it('non-main: skips ipc- IDs even when they match the trigger', () => {
      // This is the dispatch-routing case: an IPC-injected message has a
      // synthetic id like `ipc-2026-04-10T04:45:00.620Z-gii5uo` which is
      // NOT a valid Slack thread_ts and will be rejected by chat.postMessage.
      const ipcRouted = makeMessage({
        id: 'ipc-2026-04-10T04:45:00.620Z-gii5uo',
        content: '@Fleet [DISPATCH-ROUTED] Fix PR #101 CI failure',
      });

      const result = selectThreadMessage(
        [ipcRouted],
        false,
        'slack:C0ANT2AL2AY',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result).toBeUndefined();
    });

    it('non-main: falls through to earlier real Slack message when latest is ipc-', () => {
      const realTrigger = makeMessage({
        id: '1775796264.585709',
        content: '@Fleet check on this PR',
      });
      const ipcRouted = makeMessage({
        id: 'ipc-2026-04-10T04:45:00.620Z-gii5uo',
        content: '@Fleet [DISPATCH-ROUTED] Fix PR #101',
      });

      const result = selectThreadMessage(
        [realTrigger, ipcRouted],
        false,
        'slack:C0ANT2AL2AY',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result?.id).toBe('1775796264.585709');
    });

    it('main: skips ipc- IDs and uses latest real message', () => {
      const oldReal = makeMessage({
        id: '1775796200.000000',
        content: 'older real message',
      });
      const ipcRouted = makeMessage({
        id: 'ipc-2026-04-10T04:45:00.620Z-gii5uo',
        content: 'injected via IPC',
      });

      const result = selectThreadMessage(
        [oldReal, ipcRouted],
        true,
        'slack:C0APW8L9V6E',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result?.id).toBe('1775796200.000000');
    });

    it('main: returns undefined when all messages have synthetic ipc- IDs', () => {
      const ipc1 = makeMessage({
        id: 'ipc-2026-04-10T04:45:00.000Z-aaa',
        content: 'first ipc',
      });
      const ipc2 = makeMessage({
        id: 'ipc-2026-04-10T04:46:00.000Z-bbb',
        content: 'second ipc',
      });

      const result = selectThreadMessage(
        [ipc1, ipc2],
        true,
        'slack:C0APW8L9V6E',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result).toBeUndefined();
    });

    it('non-main: returns undefined when only ipc- trigger messages exist', () => {
      const ipcTrigger1 = makeMessage({
        id: 'ipc-2026-04-10T04:45:00.000Z-aaa',
        content: '@Fleet [ROUTED] task 1',
      });
      const ipcTrigger2 = makeMessage({
        id: 'ipc-2026-04-10T04:46:00.000Z-bbb',
        content: '@Fleet [ROUTED] task 2',
      });

      const result = selectThreadMessage(
        [ipcTrigger1, ipcTrigger2],
        false,
        'slack:C0ANT2AL2AY',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result).toBeUndefined();
    });
  });

  // --- Option B: real-ts IPC injection rows MUST be picked as thread anchor ---
  // This pins the actual win of Option B. Pre-Option-B (and pre-fix), the IPC
  // injection used a synthetic `ipc-` id and was filtered out. With Option B,
  // injectMessage stores the real Slack ts as messages.id, and that row must
  // be picked by selectThreadMessage so the target group's reply threads under
  // the routing message instead of posting to the main channel.
  describe('Option B: real-ts IPC injection as thread anchor', () => {
    it('non-main: picks an IPC row whose id is a real Slack ts', () => {
      const ipcRealTs = makeMessage({
        id: '1775796300.543699',
        sender: 'ipc',
        sender_name: 'ipc:slack_dispatch',
        is_from_me: true,
        content: '@Fleet [DISPATCH-ROUTED] Fix PR #101',
      });
      const result = selectThreadMessage(
        [ipcRealTs],
        false,
        'slack:C0ANT2AL2AY',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result?.id).toBe('1775796300.543699');
    });

    it('main: picks an IPC row whose id is a real Slack ts as the latest anchor', () => {
      const ipcRealTs = makeMessage({
        id: '1775796300.543699',
        sender: 'ipc',
        sender_name: 'ipc:slack_dispatch',
        is_from_me: true,
        content: '@Fleet [DISPATCH-ROUTED] Fix PR #101',
      });
      const result = selectThreadMessage(
        [ipcRealTs],
        true,
        'slack:C0APW8L9V6E',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result?.id).toBe('1775796300.543699');
    });

    it('non-main: prefers a real-ts IPC row over an earlier synthetic row', () => {
      // Mixed history: an old synthetic row (pre-Option-B) and a new
      // Option-B row with a real ts. selectThreadMessage walks backward and
      // should land on the real-ts row.
      const oldSynthetic = makeMessage({
        id: 'ipc-2026-04-10T04:45:00.620Z-gii5uo',
        sender: 'ipc',
        sender_name: 'ipc:slack_dispatch',
        is_from_me: true,
        content: '@Fleet [DISPATCH-ROUTED] earlier task',
      });
      const newReal = makeMessage({
        id: '1775796400.000001',
        sender: 'ipc',
        sender_name: 'ipc:slack_dispatch',
        is_from_me: true,
        content: '@Fleet [DISPATCH-ROUTED] later task',
      });
      const result = selectThreadMessage(
        [oldSynthetic, newReal],
        false,
        'slack:C0ANT2AL2AY',
        TRIGGER_PATTERN,
        alwaysAllowed,
        noopLoader,
      );
      expect(result?.id).toBe('1775796400.000001');
    });
  });
});

describe('isValidThreadTs', () => {
  it('rejects synthetic ipc- IDs', async () => {
    const { isValidThreadTs } = await import('./index.js');
    expect(isValidThreadTs('ipc-2026-04-10T04:45:00.620Z-gii5uo')).toBe(false);
  });

  it('accepts real Slack timestamps', async () => {
    const { isValidThreadTs } = await import('./index.js');
    expect(isValidThreadTs('1775796264.585709')).toBe(true);
  });

  it('rejects undefined', async () => {
    const { isValidThreadTs } = await import('./index.js');
    expect(isValidThreadTs(undefined)).toBe(false);
  });

  it('rejects empty string', async () => {
    const { isValidThreadTs } = await import('./index.js');
    expect(isValidThreadTs('')).toBe(false);
  });
});
