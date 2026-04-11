/**
 * Tests for writeDiagZeroTokensToFile().
 *
 * The actual writeDiagZeroTokensToFile() is inside container/agent-runner/src/index.ts
 * which cannot be imported here (depends on @anthropic-ai/claude-agent-sdk).
 * This test replicates the helper verbatim to verify the file write contract.
 * If the source changes, this replica must be updated too.
 *
 * Background: NanoClaw's container-runner.ts only persists container stderr in
 * per-container log files when LOG_LEVEL=debug or when the container exits with
 * non-zero code. Successful dispatch runs (the common case) drop stderr entirely,
 * so the existing `log()`-based DIAG line never reaches an operator. This file
 * write bypasses the per-container log policy so we can root-cause the isMain
 * SDK token gap from the host side.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Replica of writeDiagZeroTokensToFile() from container/agent-runner/src/index.ts.
// Parameterized on `ipcDiagDir` and `logFn` so the test can substitute a tmp dir
// and capture log calls without touching /workspace/ipc.
function writeDiagZeroTokensToFile(ipcDiagDir, logFn, diagData) {
  try {
    const safeTimestamp = diagData.timestamp.replace(/[:.]/g, '-');
    const file = path.join(
      ipcDiagDir,
      `diag-zero-tokens-${safeTimestamp}.json`,
    );
    fs.writeFileSync(file, JSON.stringify(diagData, null, 2));
  } catch (err) {
    logFn(`DIAG file write failed: ${err}`);
  }
}

describe('writeDiagZeroTokensToFile', () => {
  let tmpDir;
  let logCalls;
  let logFn;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-diag-test-'));
    logCalls = [];
    logFn = (msg) => logCalls.push(msg);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a JSON file with all diagnostic fields preserved', () => {
    const diagData = {
      timestamp: '2026-04-11T23:00:37.422Z',
      sessionId: 'f54b6ab7-66da-4cca-aa3f-2bca79430db7',
      sdkCost: 0.328,
      resultUsage: null,
      modelUsage: null,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      detectedModel: 'claude-sonnet-4-6',
    };

    writeDiagZeroTokensToFile(tmpDir, logFn, diagData);

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^diag-zero-tokens-.*\.json$/);

    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8'));
    expect(written).toEqual(diagData);
    expect(logCalls).toHaveLength(0);
  });

  it('sanitizes ISO timestamp into a filesystem-safe filename slug', () => {
    // Filesystems on most platforms reject `:` in filenames. The helper
    // must replace both `:` and `.` from the ISO format.
    const diagData = {
      timestamp: '2026-04-11T23:00:37.422Z',
      sessionId: null,
      sdkCost: 0.1,
      resultUsage: null,
      modelUsage: null,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      detectedModel: undefined,
    };

    writeDiagZeroTokensToFile(tmpDir, logFn, diagData);

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    // Name must NOT contain raw `:` or `.` from the ISO timestamp segment
    // (the `.json` extension's dot is fine — check the slug specifically).
    const slug = files[0].replace(/^diag-zero-tokens-/, '').replace(/\.json$/, '');
    expect(slug).not.toContain(':');
    expect(slug).not.toContain('.');
    expect(slug).toBe('2026-04-11T23-00-37-422Z');
  });

  it('accumulates one file per call (multiple dispatch runs do not overwrite)', () => {
    // The whole point of timestamping the filename is so multiple isMain
    // dispatch runs that hit the DIAG condition each leave a distinct
    // evidence file. Verify two consecutive calls produce two files.
    const baseDiag = {
      sessionId: null,
      sdkCost: 0.1,
      resultUsage: null,
      modelUsage: null,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      detectedModel: undefined,
    };

    writeDiagZeroTokensToFile(tmpDir, logFn, {
      ...baseDiag,
      timestamp: '2026-04-11T23:00:37.422Z',
    });
    writeDiagZeroTokensToFile(tmpDir, logFn, {
      ...baseDiag,
      timestamp: '2026-04-11T23:01:24.662Z',
    });

    const files = fs.readdirSync(tmpDir).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toBe('diag-zero-tokens-2026-04-11T23-00-37-422Z.json');
    expect(files[1]).toBe('diag-zero-tokens-2026-04-11T23-01-24-662Z.json');
  });

  it('preserves nested SDK shapes (resultUsage / modelUsage objects)', () => {
    // When the SDK DOES populate usage on a future run, the diagnostic
    // must capture the nested shape exactly so we can compare it against
    // the missing-shape case.
    const diagData = {
      timestamp: '2026-04-11T23:00:37.422Z',
      sessionId: 'session-1',
      sdkCost: 0.5,
      resultUsage: {
        input_tokens: 1234,
        output_tokens: 567,
        cache_creation_input_tokens: 89,
        cache_read_input_tokens: 1011,
      },
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 1234,
          outputTokens: 567,
        },
      },
      accumulatedUsage: {
        inputTokens: 1234,
        outputTokens: 567,
        cacheCreationInputTokens: 89,
        cacheReadInputTokens: 1011,
      },
      detectedModel: 'claude-sonnet-4-6',
    };

    writeDiagZeroTokensToFile(tmpDir, logFn, diagData);

    const files = fs.readdirSync(tmpDir);
    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8'));
    expect(written.resultUsage).toEqual(diagData.resultUsage);
    expect(written.modelUsage).toEqual(diagData.modelUsage);
  });

  it('best-effort: never throws, falls back to logFn on write failure', () => {
    // Pass a path that does not exist and is not creatable (e.g. a
    // path under a missing parent dir on a read-only filesystem). The
    // helper must catch the error and route it to logFn instead of
    // throwing, so the cost reporting path is never blocked.
    const badDir = path.join(tmpDir, 'no-such-subdir-that-was-not-created');
    const diagData = {
      timestamp: '2026-04-11T23:00:37.422Z',
      sessionId: null,
      sdkCost: 0.1,
      resultUsage: null,
      modelUsage: null,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      detectedModel: undefined,
    };

    expect(() => writeDiagZeroTokensToFile(badDir, logFn, diagData)).not.toThrow();
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]).toContain('DIAG file write failed');
  });
});
