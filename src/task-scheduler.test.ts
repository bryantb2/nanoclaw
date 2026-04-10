import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

// Mock container-runner so tests don't need Docker
vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});

describe('budget exhaustion notification', () => {
  let runContainerAgentMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    const mod = await import('./container-runner.js');
    runContainerAgentMock = mod.runContainerAgent as ReturnType<typeof vi.fn>;
    runContainerAgentMock.mockReset();
    (mod.writeTasksSnapshot as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('sends budget exhaustion Slack message when error contains "budget"', async () => {
    createTask({
      id: 'task-budget-test',
      group_folder: 'slack_test-group',
      chat_jid: 'test-channel@slack',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    runContainerAgentMock.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'Agent exceeded budget limit of $3.00',
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const enqueueTask = vi.fn(
      (_jid: string, _id: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'test-channel@slack': {
          jid: 'test-channel@slack',
          folder: 'slack_test-group',
          isMain: false,
          context_mode: 'isolated',
        } as any,
      }),
      getSessions: () => ({}),
      queue: { enqueueTask, closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(100);

    // sendMessage must have been called with budget exhaustion notice
    const budgetCall = sendMessage.mock.calls.find(
      (call) => /budget/i.test(String(call[1])),
    );
    expect(budgetCall).toBeDefined();
    expect(budgetCall![0]).toBe('test-channel@slack');
    expect(budgetCall![1]).toMatch(/task-budget-test/);
    expect(budgetCall![1]).toMatch(/\$\d+\.\d{2}/);
  });

  it('does NOT send budget notification when error does not contain "budget"', async () => {
    createTask({
      id: 'task-normal-error',
      group_folder: 'slack_test-group',
      chat_jid: 'test-channel@slack',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    runContainerAgentMock.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'Container crashed unexpectedly',
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const enqueueTask = vi.fn(
      (_jid: string, _id: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'test-channel@slack': {
          jid: 'test-channel@slack',
          folder: 'slack_test-group',
          isMain: false,
          context_mode: 'isolated',
        } as any,
      }),
      getSessions: () => ({}),
      queue: { enqueueTask, closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(100);

    // No budget-specific message should be sent
    const budgetCall = sendMessage.mock.calls.find(
      (call) => /budget/i.test(String(call[1])),
    );
    expect(budgetCall).toBeUndefined();
  });

  it('budget notification message includes task ID and dollar cap', async () => {
    createTask({
      id: 'task-cap-check',
      group_folder: 'slack_test-group',
      chat_jid: 'cap-channel@slack',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
      max_budget_usd: 5.0,
    });

    runContainerAgentMock.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'budget exceeded',
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const enqueueTask = vi.fn(
      (_jid: string, _id: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'cap-channel@slack': {
          jid: 'cap-channel@slack',
          folder: 'slack_test-group',
          isMain: false,
          context_mode: 'isolated',
        } as any,
      }),
      getSessions: () => ({}),
      queue: { enqueueTask, closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(100);

    const budgetCall = sendMessage.mock.calls.find(
      (call) => /budget/i.test(String(call[1])),
    );
    expect(budgetCall).toBeDefined();
    expect(budgetCall![1]).toContain('task-cap-check');
    expect(budgetCall![1]).toContain('$5.00');
  });
});

describe('computeNextRun', () => {
  it('returns next cron time for cron tasks', () => {
    const result = computeNextRun({
      id: 'test',
      group_folder: 'main',
      chat_jid: 'g@g.us',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '*/30 * * * *',
      context_mode: 'isolated',
      next_run: null,
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    expect(result).not.toBeNull();
    expect(new Date(result!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('handles NULL next_run for interval tasks without crashing', () => {
    const result = computeNextRun({
      id: 'test-interval',
      group_folder: 'main',
      chat_jid: 'g@g.us',
      prompt: 'test',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: null,
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    expect(result).not.toBeNull();
    // Should be ~60s in the future (anchored to now since next_run is null)
    const delta = new Date(result!).getTime() - Date.now();
    expect(delta).toBeGreaterThan(50000);
    expect(delta).toBeLessThan(70000);
  });

  it('returns null for once tasks', () => {
    const result = computeNextRun({
      id: 'test-once',
      group_folder: 'main',
      chat_jid: 'g@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    expect(result).toBeNull();
  });
});
