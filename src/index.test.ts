import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Hoisted mock factories (referenced in vi.mock factories below) ---

const {
  deleteSessionMock,
  setSessionMock,
  appendCostLogMock,
  getCostSummaryMock,
  getAllSessionsMock,
  getAllRegisteredGroupsMock,
  getAllChatsMock,
  getAllTasksMock,
  getMessagesSinceMock,
  getRouterStateMock,
  setRouterStateMock,
  initDatabaseMock,
  setRegisteredGroupMock,
  storeChatMetadataMock,
  storeMessageMock,
  getAndClearInFlightTasksMock,
  runContainerAgentMock,
  writeGroupsSnapshotMock,
  writeTasksSnapshotMock,
  mockSendMessage,
} = vi.hoisted(() => ({
  deleteSessionMock: vi.fn(),
  setSessionMock: vi.fn(),
  appendCostLogMock: vi.fn(),
  getCostSummaryMock: vi.fn(() => ({ todayUsd: 0, weekUsd: 0, allTimeUsd: 0 })),
  getAllSessionsMock: vi.fn(() => ({})),
  getAllRegisteredGroupsMock: vi.fn(() => ({})),
  getAllChatsMock: vi.fn(() => []),
  getAllTasksMock: vi.fn(() => []),
  getMessagesSinceMock: vi.fn(() => []),
  getRouterStateMock: vi.fn(() => null),
  setRouterStateMock: vi.fn(),
  initDatabaseMock: vi.fn(),
  setRegisteredGroupMock: vi.fn(),
  storeChatMetadataMock: vi.fn(),
  storeMessageMock: vi.fn(),
  getAndClearInFlightTasksMock: vi.fn(() => []),
  runContainerAgentMock: vi.fn(),
  writeGroupsSnapshotMock: vi.fn(),
  writeTasksSnapshotMock: vi.fn(),
  mockSendMessage: vi.fn().mockResolvedValue(undefined),
}));

// --- Mocks ---

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Fleet',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  ONECLI_URL: 'http://localhost:10254',
  POLL_INTERVAL: 1000,
  TIMEZONE: 'America/Los_Angeles',
  TRIGGER_PATTERN: /^@Fleet\b/i,
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
  deleteSession: deleteSessionMock,
  setSession: setSessionMock,
  getSession: vi.fn(() => undefined),
  appendCostLog: appendCostLogMock,
  getCostSummary: getCostSummaryMock,
  getAllSessions: getAllSessionsMock,
  getAllRegisteredGroups: getAllRegisteredGroupsMock,
  getAllChats: getAllChatsMock,
  getAllTasks: getAllTasksMock,
  getMessagesSince: getMessagesSinceMock,
  getNewMessages: vi.fn(() => []),
  getRouterState: getRouterStateMock,
  setRouterState: setRouterStateMock,
  initDatabase: initDatabaseMock,
  setRegisteredGroup: setRegisteredGroupMock,
  storeChatMetadata: storeChatMetadataMock,
  storeMessage: storeMessageMock,
  getAndClearInFlightTasks: getAndClearInFlightTasksMock,
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: runContainerAgentMock,
  writeGroupsSnapshot: writeGroupsSnapshotMock,
  writeTasksSnapshot: writeTasksSnapshotMock,
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn((folder: string) => `/tmp/groups/${folder}`),
  isValidGroupFolder: vi.fn(() => true),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      existsSync: vi.fn(() => false),
    },
  };
});

vi.mock('./channels/index.js', () => ({}));

vi.mock('./channels/registry.js', () => ({
  getChannelFactory: vi.fn(() => null),
  getRegisteredChannelNames: vi.fn(() => []),
}));

vi.mock('./container-runtime.js', () => ({
  cleanupOrphans: vi.fn(),
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
  loadSenderAllowlist: vi.fn(() => []),
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
    sendMessage: mockSendMessage,
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

// --- Import module under test ---

import { _runAgent } from './index.js';
import { RegisteredGroup } from './types.js';

// --- Helpers ---

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'TestGroup',
    folder: 'test-group',
    trigger: 'fleet',
    added_at: '2026-01-01T00:00:00.000Z',
    isMain: false,
    ...overrides,
  };
}

// --- Tests ---

describe('runAgent()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCostSummaryMock.mockReturnValue({ todayUsd: 0, weekUsd: 0, allTimeUsd: 0 });
    writeTasksSnapshotMock.mockReturnValue(undefined);
    writeGroupsSnapshotMock.mockReturnValue(undefined);
    getAllTasksMock.mockReturnValue([]);
    getAllChatsMock.mockReturnValue([]);
    getAllRegisteredGroupsMock.mockReturnValue({});
  });

  describe('stale session handling', () => {
    it('clears session and retries once when stale session error occurs', async () => {
      const group = makeGroup();

      runContainerAgentMock
        .mockResolvedValueOnce({
          status: 'error',
          error: 'No conversation found for session_id abc123',
        })
        .mockResolvedValueOnce({
          status: 'success',
          result: 'Done',
          totalCostUsd: 0,
        });

      const result = await _runAgent(group, 'hello', 'slack:C123');

      expect(result).toBe('success');
      expect(runContainerAgentMock).toHaveBeenCalledTimes(2);
      expect(deleteSessionMock).toHaveBeenCalledWith(group.folder);
    });

    it('returns error without further recursion when retry also fails with stale session', async () => {
      const group = makeGroup();

      runContainerAgentMock
        .mockResolvedValueOnce({
          status: 'error',
          error: 'No conversation found for session',
        })
        .mockResolvedValueOnce({
          status: 'error',
          error: 'No conversation found for session',
        });

      const result = await _runAgent(group, 'hello', 'slack:C123');

      expect(result).toBe('error');
      expect(runContainerAgentMock).toHaveBeenCalledTimes(2);
    });

    it('returns error immediately without retry on non-stale errors', async () => {
      const group = makeGroup();

      runContainerAgentMock.mockResolvedValueOnce({
        status: 'error',
        error: 'Container timeout after 1800s',
      });

      const result = await _runAgent(group, 'hello', 'slack:C123');

      expect(result).toBe('error');
      expect(runContainerAgentMock).toHaveBeenCalledTimes(1);
      expect(deleteSessionMock).not.toHaveBeenCalled();
    });
  });

  describe('cost integration (RELY-01)', () => {
    it('calls appendCostLog with correct args when totalCostUsd > 0', async () => {
      const group = makeGroup();

      runContainerAgentMock.mockResolvedValueOnce({
        status: 'success',
        result: 'Done',
        totalCostUsd: 0.05,
      });

      await _runAgent(group, 'hello', 'slack:C123');

      expect(appendCostLogMock).toHaveBeenCalledWith(
        group.folder,
        'slack:C123',
        0.05,
      );
    });

    it('does NOT call appendCostLog when totalCostUsd is 0', async () => {
      const group = makeGroup();

      runContainerAgentMock.mockResolvedValueOnce({
        status: 'success',
        result: 'Done',
        totalCostUsd: 0,
      });

      await _runAgent(group, 'hello', 'slack:C123');

      expect(appendCostLogMock).not.toHaveBeenCalled();
    });
  });
});
