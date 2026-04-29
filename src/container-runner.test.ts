import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      // Cache-refresh helper invokes these every spawn (PR #40 Option B
      // fixups). Mock as no-ops since the unit tests in
      // refresh-agent-runner-src-cache.test.ts cover the real semantics
      // against a tmp dir; here we only care that the helper is invoked
      // with the correct arguments.
      cpSync: vi.fn(),
      rmSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  runContainerAgent,
  ContainerOutput,
  TokenUsage,
  mergeCompletionRecordRuntime,
  notifyDispatchOfRoutedCompletion,
  setEnqueueMessageCheckFn,
} from './container-runner.js';
import fs from 'fs';
import path from 'path';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('cost tracking through container-runner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accumulates computedCostUsd from output markers', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit result with computed cost
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'sess-1',
      totalCostUsd: 0.05,
      computedCostUsd: 0.08,
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 100,
      },
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    // computedCostUsd should be preferred
    expect(result.computedCostUsd).toBe(0.08);
    expect(result.tokenUsage).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 100,
    });
  });

  it('falls back to SDK totalCostUsd when computedCostUsd is absent', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'sess-2',
      totalCostUsd: 0.12,
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.totalCostUsd).toBe(0.12);
    expect(result.computedCostUsd).toBeUndefined();
  });

  it('accumulates cost across multiple query boundaries', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Query 1 result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'First response',
      newSessionId: 'sess-3',
      totalCostUsd: 0.1,
      computedCostUsd: 0.15,
    });
    await vi.advanceTimersByTimeAsync(10);

    // Session-update marker (query boundary flush)
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'sess-3',
    });
    await vi.advanceTimersByTimeAsync(10);

    // Query 2 result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Second response',
      newSessionId: 'sess-3',
      totalCostUsd: 0.08,
      computedCostUsd: 0.12,
    });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // Query 1: 0.15 flushed at boundary + Query 2: 0.12 flushed at close = 0.27
    expect(result.computedCostUsd).toBeCloseTo(0.27, 4);
    // bestCost prefers computed over SDK, so totalCostUsd also reflects computed
    expect(result.totalCostUsd).toBeCloseTo(0.27, 4);
  });

  it('reports cost on error exit', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Partial work',
      newSessionId: 'sess-4',
      totalCostUsd: 0.03,
      computedCostUsd: 0.05,
    });

    await vi.advanceTimersByTimeAsync(10);

    // Error exit
    fakeProc.stderr.push('fatal error\n');
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.computedCostUsd).toBe(0.05);
    expect(result.totalCostUsd).toBe(0.05); // bestCost prefers computed
  });

  it('recovers cost from IPC file when container times out with no output', async () => {
    // Mock fs.readFileSync to return IPC cost data for the cost.json path
    const fs = (await import('fs')).default;
    const originalReadFileSync = fs.readFileSync;
    const originalUnlinkSync = fs.unlinkSync;
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: unknown) => {
        if (typeof p === 'string' && p.endsWith('cost.json')) {
          return JSON.stringify({
            costUsd: 0.42,
            inputTokens: 8000,
            outputTokens: 2000,
            cacheCreationInputTokens: 500,
            cacheReadInputTokens: 3000,
            updatedAt: new Date().toISOString(),
          });
        }
        return '';
      },
    );
    (fs.unlinkSync as unknown as ReturnType<typeof vi.fn>) = vi.fn();

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(result.totalCostUsd).toBeCloseTo(0.42);
    expect(result.computedCostUsd).toBeCloseTo(0.42);
    expect(result.tokenUsage).toEqual({
      inputTokens: 8000,
      outputTokens: 2000,
      cacheCreationInputTokens: 500,
      cacheReadInputTokens: 3000,
    });

    // Restore mocks
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => '');
    (fs.unlinkSync as unknown) = originalUnlinkSync;
    void originalReadFileSync;
  });
});

// --- Integration: cache refresh wiring (Option B fixup #4 from PR #40 review) ---
//
// The 11 unit tests in refresh-agent-runner-src-cache.test.ts cover the helper's
// real wipe-and-recopy semantics against a tmp dir. THIS test pins the wiring
// between buildVolumeMounts and the helper: it asserts that runContainerAgent
// (the only production entry point that calls buildVolumeMounts) actually
// invokes cpSync/rmSync/renameSync on the agent-runner src cache path. Without
// this test, a future refactor that drops the helper invocation entirely would
// not break a single existing test — and the populate-once regression would
// silently return.

describe('container-runner agent-runner cache refresh wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    // Mock fs calls used by the cache-refresh helper. cpSync/rmSync/renameSync
    // are no-ops in the global mock; we just need to verify they were CALLED
    // with the expected arguments.
    (fs.cpSync as ReturnType<typeof vi.fn>).mockClear();
    (fs.rmSync as ReturnType<typeof vi.fn>).mockClear();
    (fs.renameSync as ReturnType<typeof vi.fn>).mockClear();
    // existsSync needs to return true for `agentRunnerSrc` so the helper
    // doesn't short-circuit. Default is `false`; we override per-test.
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: string) => {
        // Return true ONLY for the agent-runner src path; everything else
        // (including the dest dir, output dir, IPC dir) defaults to false
        // so the rest of buildVolumeMounts behaves as before.
        return p.includes(path.join('container', 'agent-runner', 'src'));
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation(() => false);
  });

  it('invokes cpSync on the agent-runner src path during runContainerAgent', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'done',
      newSessionId: 'session-cache-test',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    // Find the cpSync call that targets the agent-runner src cache. Other
    // cpSync calls (e.g. skills sync) may also fire from buildVolumeMounts;
    // filter to the one we care about by checking the source path.
    const cpSyncCalls = (fs.cpSync as ReturnType<typeof vi.fn>).mock.calls;
    const agentRunnerCpCall = cpSyncCalls.find((call: unknown[]) => {
      const src = call[0];
      return (
        typeof src === 'string' &&
        src.includes(path.join('container', 'agent-runner', 'src'))
      );
    });

    expect(agentRunnerCpCall).toBeDefined();
    // Atomic-rename pattern: cpSync target should be the SCRATCH dir
    // (`<dest>.new`), NOT the final dest. The renameSync below moves it
    // into place. If a future refactor accidentally reverts to direct
    // cpSync into dest, this assertion fails loudly.
    const cpDest = agentRunnerCpCall![1] as string;
    expect(cpDest).toContain(
      path.join('sessions', 'test-group', 'agent-runner-src'),
    );
    expect(cpDest.endsWith('.new')).toBe(true);
  });

  it('invokes renameSync to swap the scratch dir into place', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'done',
      newSessionId: 'session-rename-test',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    // The atomic-rename pattern's final step is renameSync(scratch, dest).
    // If anyone reverts to in-place cpSync (no rename) this test fails.
    const renameSyncCalls = (fs.renameSync as ReturnType<typeof vi.fn>).mock
      .calls;
    const renameCall = renameSyncCalls.find((call: unknown[]) => {
      const src = call[0];
      const dest = call[1];
      return (
        typeof src === 'string' &&
        typeof dest === 'string' &&
        src.endsWith('.new') &&
        src.includes(
          path.join('sessions', 'test-group', 'agent-runner-src.new'),
        ) &&
        dest.includes(path.join('sessions', 'test-group', 'agent-runner-src'))
      );
    });

    expect(renameCall).toBeDefined();
  });
});

describe('mergeCompletionRecordRuntime', () => {
  it('uses runtime cost/tokens/wallClock when agent values are 0', () => {
    // The "all zeros" case — agent has no SDK access so writes 0,0,0.
    // Runtime captures real values from the streaming output.
    const merged = mergeCompletionRecordRuntime(
      { costUsd: 0, inputTokens: 0, outputTokens: 0, wallClockMs: 0 },
      {
        costUsd: 1.7626,
        tokenUsage: {
          inputTokens: 34,
          outputTokens: 5889,
          cacheCreationInputTokens: 144918,
          cacheReadInputTokens: 4640023,
        },
        wallClockMs: 158234,
      },
    );
    expect(merged.costUsd).toBeCloseTo(1.7626, 4);
    expect(merged.inputTokens).toBe(34);
    expect(merged.outputTokens).toBe(5889);
    expect(merged.wallClockMs).toBe(158234);
  });

  it('falls back to agent values when no runtime override is supplied', () => {
    const merged = mergeCompletionRecordRuntime({
      costUsd: 0.42,
      inputTokens: 100,
      outputTokens: 200,
      wallClockMs: 5000,
    });
    expect(merged.costUsd).toBeCloseTo(0.42, 4);
    expect(merged.inputTokens).toBe(100);
    expect(merged.outputTokens).toBe(200);
    expect(merged.wallClockMs).toBe(5000);
  });

  it('keeps agent value when runtime is 0 (orchestrator captured nothing)', () => {
    // Edge case: runtime cost = 0 means orchestrator never saw a result marker.
    // Agent's self-reported value (if any) wins.
    const merged = mergeCompletionRecordRuntime(
      { costUsd: 0.5, inputTokens: 50, outputTokens: 100 },
      {
        costUsd: 0,
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    );
    expect(merged.costUsd).toBeCloseTo(0.5, 4);
    expect(merged.inputTokens).toBe(50);
    expect(merged.outputTokens).toBe(100);
  });

  it('returns 0/null when both agent and runtime are missing/zero', () => {
    const merged = mergeCompletionRecordRuntime({});
    expect(merged.costUsd).toBe(0);
    expect(merged.inputTokens).toBeNull();
    expect(merged.outputTokens).toBeNull();
    expect(merged.wallClockMs).toBeNull();
  });

  it('preserves agent costUsd when runtime undefined', () => {
    const merged = mergeCompletionRecordRuntime({ costUsd: 0.99 }, undefined);
    expect(merged.costUsd).toBeCloseTo(0.99, 4);
  });

  it('uses runtime even when agent supplied a different positive value (orchestrator wins)', () => {
    // The agent might dutifully copy the cost from somewhere stale.
    // The orchestrator's value is authoritative since it's pulled from the
    // SDK result marker the agent process can't see.
    const merged = mergeCompletionRecordRuntime(
      { costUsd: 0.01, inputTokens: 1, outputTokens: 1, wallClockMs: 1 },
      {
        costUsd: 2.5,
        tokenUsage: {
          inputTokens: 99,
          outputTokens: 99,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        wallClockMs: 99999,
      },
    );
    expect(merged.costUsd).toBeCloseTo(2.5, 4);
    expect(merged.inputTokens).toBe(99);
    expect(merged.outputTokens).toBe(99);
    expect(merged.wallClockMs).toBe(99999);
  });

  it('handles partial runtime overrides (cost only, no tokens)', () => {
    const merged = mergeCompletionRecordRuntime(
      { costUsd: 0, inputTokens: 50, outputTokens: 100, wallClockMs: 5000 },
      { costUsd: 1.5 }, // no tokenUsage, no wallClockMs
    );
    expect(merged.costUsd).toBeCloseTo(1.5, 4);
    expect(merged.inputTokens).toBe(50);
    expect(merged.outputTokens).toBe(100);
    expect(merged.wallClockMs).toBe(5000);
  });

  it('handles agent inputTokens=null (schema allows null)', () => {
    const merged = mergeCompletionRecordRuntime(
      { costUsd: 0, inputTokens: null, outputTokens: null, wallClockMs: null },
      undefined,
    );
    expect(merged.inputTokens).toBeNull();
    expect(merged.outputTokens).toBeNull();
    expect(merged.wallClockMs).toBeNull();
  });
});

describe('notifyDispatchOfRoutedCompletion', () => {
  // These tests exercise the cross-group fleet-event wake-up path. They use
  // a real (in-memory) test DB so we can verify storeMessage actually lands
  // a row, plus a mock enqueueMessageCheck callback to verify wake-up fires.

  beforeEach(async () => {
    const db = await import('./db.js');
    db._initTestDatabase();
    setEnqueueMessageCheckFn(null); // reset between tests
  });

  afterEach(() => {
    setEnqueueMessageCheckFn(null);
  });

  it('does nothing when dispatchRouted is false', async () => {
    const enqueue = vi.fn();
    setEnqueueMessageCheckFn(enqueue);
    const db = await import('./db.js');
    db.setRegisteredGroup('slack:C0DISPATCH', {
      name: 'Dispatch',
      folder: 'slack_dispatch',
      trigger: '@Fleet',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });
    notifyDispatchOfRoutedCompletion('slack_dev-team', {
      linearTicketId: 'KRE-186',
      prUrl: 'https://github.com/x/y/pull/130',
      branchName: 'fleet/kre-186',
      repo: 'x/y',
      dispatchRouted: false, // ← key
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does nothing when no main group is registered', async () => {
    const enqueue = vi.fn();
    setEnqueueMessageCheckFn(enqueue);
    // Note: no setRegisteredGroup call — DB is empty
    notifyDispatchOfRoutedCompletion('slack_dev-team', {
      linearTicketId: 'KRE-186',
      prUrl: 'https://github.com/x/y/pull/130',
      dispatchRouted: true,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does nothing when enqueueMessageCheckFn is not wired', async () => {
    setEnqueueMessageCheckFn(null);
    const db = await import('./db.js');
    db.setRegisteredGroup('slack:C0DISPATCH', {
      name: 'Dispatch',
      folder: 'slack_dispatch',
      trigger: '@Fleet',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });
    // Should not throw — early-returns silently
    expect(() =>
      notifyDispatchOfRoutedCompletion('slack_dev-team', {
        linearTicketId: 'KRE-186',
        prUrl: 'https://github.com/x/y/pull/130',
        dispatchRouted: true,
      }),
    ).not.toThrow();
  });

  it('wakes dispatch and stores a [COMPLETION] message on routed completion', async () => {
    const enqueue = vi.fn();
    setEnqueueMessageCheckFn(enqueue);
    const db = await import('./db.js');
    db.setRegisteredGroup('slack:C0DISPATCH', {
      name: 'Dispatch',
      folder: 'slack_dispatch',
      trigger: '@Fleet',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });
    db.storeChatMetadata('slack:C0DISPATCH', '2024-01-01T00:00:00.000Z');

    notifyDispatchOfRoutedCompletion('slack_dev-team', {
      linearTicketId: 'KRE-186',
      prUrl: 'https://github.com/x/y/pull/130',
      branchName: 'fleet/kre-186',
      repo: 'x/y',
      dispatchRouted: true,
    });

    expect(enqueue).toHaveBeenCalledWith('slack:C0DISPATCH');

    // Verify the synthetic message landed in dispatch's queue and is visible
    // to getNewMessages (is_bot_message=0 + bot-prefix filter).
    const { messages } = db.getNewMessages(
      ['slack:C0DISPATCH'],
      '2020-01-01T00:00:00.000Z',
      'Fleet',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('[COMPLETION]');
    expect(messages[0].content).toContain('dev-team finished: KRE-186');
    expect(messages[0].content).toContain(
      'PR(s): https://github.com/x/y/pull/130',
    );
    expect(messages[0].sender_name).toBe('fleet-event');
    expect(messages[0].is_from_me).toBe(1);
    expect(messages[0].origin).toBe('synthetic');
  });

  it('skips when source group IS the dispatch group (recursion guard)', async () => {
    const enqueue = vi.fn();
    setEnqueueMessageCheckFn(enqueue);
    const db = await import('./db.js');
    db.setRegisteredGroup('slack:C0DISPATCH', {
      name: 'Dispatch',
      folder: 'slack_dispatch',
      trigger: '@Fleet',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });
    notifyDispatchOfRoutedCompletion('slack_dispatch', {
      // ← source IS dispatch
      linearTicketId: 'KRE-999',
      prUrl: null,
      dispatchRouted: true,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('handles missing optional fields with placeholder values', async () => {
    const enqueue = vi.fn();
    setEnqueueMessageCheckFn(enqueue);
    const db = await import('./db.js');
    db.setRegisteredGroup('slack:C0DISPATCH', {
      name: 'Dispatch',
      folder: 'slack_dispatch',
      trigger: '@Fleet',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });
    db.storeChatMetadata('slack:C0DISPATCH', '2024-01-01T00:00:00.000Z');

    notifyDispatchOfRoutedCompletion('slack_dev-team', {
      linearTicketId: null, // null fields
      prUrl: null,
      branchName: null,
      repo: null,
      dispatchRouted: true,
    });

    expect(enqueue).toHaveBeenCalledOnce();
    const { messages } = db.getNewMessages(
      ['slack:C0DISPATCH'],
      '2020-01-01T00:00:00.000Z',
      'Fleet',
    );
    expect(messages[0].content).toContain('finished: unknown');
    expect(messages[0].content).toContain('PR(s): no-pr');
  });

  it('prefers a public channel over a DM when both are registered as main', async () => {
    // Production fleets often have BOTH the operator's DM with Fleet AND
    // the public #dispatch channel registered with isMain=true. Fleet events
    // must go to the public channel (team-visible), not the operator's DM.
    // Slack DM channel JIDs start with `slack:D...`, public channels with
    // `slack:C...`. The helper filters DMs and picks the most-recently-added
    // eligible main group.
    const enqueue = vi.fn();
    setEnqueueMessageCheckFn(enqueue);
    const db = await import('./db.js');
    // DM (older, registered first during setup):
    db.setRegisteredGroup('slack:D0OPDM', {
      name: 'main',
      folder: 'slack_main',
      trigger: '@Fleet',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });
    // Public dispatch channel (newer):
    db.setRegisteredGroup('slack:C0DISPATCH', {
      name: 'dispatch',
      folder: 'slack_dispatch',
      trigger: '@Fleet',
      added_at: '2024-06-01T00:00:00.000Z',
      isMain: true,
    });
    db.storeChatMetadata('slack:C0DISPATCH', '2024-06-01T00:00:00.000Z');

    notifyDispatchOfRoutedCompletion('slack_dev-team', {
      linearTicketId: 'KRE-100',
      prUrl: 'https://github.com/x/y/pull/1',
      dispatchRouted: true,
    });

    expect(enqueue).toHaveBeenCalledExactlyOnceWith('slack:C0DISPATCH');
    expect(enqueue).not.toHaveBeenCalledWith('slack:D0OPDM');
  });

  it('synthetic message id uses the ipc- prefix so isValidThreadTs filters it', async () => {
    // Regression guard: the original implementation used `event-{ts}-{rand}`
    // which slipped past the existing isValidThreadTs filter (in src/index.ts)
    // and caused agents to attempt thread_ts values Slack rejected with
    // "invalid_thread_ts", silently dropping the dispatch summary post.
    const enqueue = vi.fn();
    setEnqueueMessageCheckFn(enqueue);
    const db = await import('./db.js');
    db.setRegisteredGroup('slack:C0DISPATCH', {
      name: 'Dispatch',
      folder: 'slack_dispatch',
      trigger: '@Fleet',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });
    db.storeChatMetadata('slack:C0DISPATCH', '2024-01-01T00:00:00.000Z');

    notifyDispatchOfRoutedCompletion('slack_dev-team', {
      linearTicketId: 'KRE-100',
      prUrl: 'https://github.com/x/y/pull/1',
      dispatchRouted: true,
    });

    const { messages } = db.getNewMessages(
      ['slack:C0DISPATCH'],
      '2020-01-01T00:00:00.000Z',
      'Fleet',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toMatch(/^ipc-/);
    expect(messages[0].id).not.toMatch(/^event-/);
  });
});
