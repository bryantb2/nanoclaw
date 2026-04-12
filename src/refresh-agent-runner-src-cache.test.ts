/**
 * Tests for refreshAgentRunnerSrcCache().
 *
 * Lives in its own test file (NOT alongside the rest of container-runner
 * tests in container-runner.test.ts) because that file mocks `fs` globally
 * to intercept production calls. This helper genuinely needs real wipe-and-
 * recopy semantics against a tmp directory, so it must run with the real
 * filesystem module.
 *
 * Background: PR #29 (token-based cost tracking) shipped to the host on
 * Apr 9 but never reached cached groups because the per-group agent-runner
 * source cache was implemented with `if (!fs.existsSync(...)) cpSync(...)`
 * — populate-once-and-never-refresh. This helper replaces that logic.
 * Per-group isolation (security fix #392) is preserved by keeping the
 * cache directory per-group; only the contents are refreshed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { refreshAgentRunnerSrcCache } from './container-runner.js';

describe('refreshAgentRunnerSrcCache', () => {
  let tmpRoot: string;
  let agentRunnerSrc: string;
  let groupCacheA: string;
  let groupCacheB: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-cache-refresh-test-'),
    );
    agentRunnerSrc = path.join(tmpRoot, 'src');
    groupCacheA = path.join(
      tmpRoot,
      'sessions',
      'slack_groupA',
      'agent-runner-src',
    );
    groupCacheB = path.join(
      tmpRoot,
      'sessions',
      'slack_groupB',
      'agent-runner-src',
    );

    // Build a minimal upstream source dir with two distinct files so we
    // can verify both file contents AND directory structure are copied.
    fs.mkdirSync(agentRunnerSrc, { recursive: true });
    fs.writeFileSync(
      path.join(agentRunnerSrc, 'index.ts'),
      'export const VERSION = "fresh";\n',
    );
    fs.writeFileSync(
      path.join(agentRunnerSrc, 'helper.ts'),
      'export function helper(): string { return "fresh"; }\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates the cache directory when it does not exist', () => {
    expect(fs.existsSync(groupCacheA)).toBe(false);

    refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA);

    expect(fs.existsSync(groupCacheA)).toBe(true);
    expect(fs.readFileSync(path.join(groupCacheA, 'index.ts'), 'utf-8')).toBe(
      'export const VERSION = "fresh";\n',
    );
    expect(fs.readFileSync(path.join(groupCacheA, 'helper.ts'), 'utf-8')).toBe(
      'export function helper(): string { return "fresh"; }\n',
    );
  });

  it('REFRESHES a stale cache (the regression fix from PR #29 cache bug)', () => {
    // Pre-seed a stale cache that mimics the prod state on Apr 9: the cache
    // exists but contains an OLDER version of the source. The previous
    // populate-once-and-never-refresh implementation would have left this
    // intact, silently swallowing every agent-runner change since the cache
    // was first populated.
    fs.mkdirSync(groupCacheA, { recursive: true });
    fs.writeFileSync(
      path.join(groupCacheA, 'index.ts'),
      'export const VERSION = "STALE_FROM_APRIL_9";\n',
    );
    // Stale cache also has a file that the upstream no longer has —
    // verify it gets removed (full wipe, not partial overlay).
    fs.writeFileSync(
      path.join(groupCacheA, 'removed-in-newer-source.ts'),
      'export const REMOVED = true;\n',
    );

    refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA);

    // Stale content must be replaced with fresh upstream content.
    expect(fs.readFileSync(path.join(groupCacheA, 'index.ts'), 'utf-8')).toBe(
      'export const VERSION = "fresh";\n',
    );
    // Stale-only file must be gone.
    expect(
      fs.existsSync(path.join(groupCacheA, 'removed-in-newer-source.ts')),
    ).toBe(false);
    // Fresh-only files must be present.
    expect(fs.existsSync(path.join(groupCacheA, 'helper.ts'))).toBe(true);
  });

  it('preserves per-group isolation (security fix #392)', () => {
    // Two groups must each get an INDEPENDENT writable copy at distinct
    // paths. A change to one group's cache must not leak into another.
    refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA);
    refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheB);

    expect(fs.existsSync(groupCacheA)).toBe(true);
    expect(fs.existsSync(groupCacheB)).toBe(true);
    expect(path.dirname(groupCacheA)).not.toBe(path.dirname(groupCacheB));

    // Mutating group A's cache must not affect group B's cache.
    fs.writeFileSync(
      path.join(groupCacheA, 'index.ts'),
      'export const VERSION = "agentA-customized";\n',
    );
    expect(fs.readFileSync(path.join(groupCacheA, 'index.ts'), 'utf-8')).toBe(
      'export const VERSION = "agentA-customized";\n',
    );
    expect(fs.readFileSync(path.join(groupCacheB, 'index.ts'), 'utf-8')).toBe(
      'export const VERSION = "fresh";\n',
    );
  });

  it('refresh wipes per-group customizations (acceptable trade-off)', () => {
    // The trade-off documented in the helper comment: customizations
    // written into the cache between spawns DO get wiped on refresh.
    // No code currently relies on this (verified by codebase search), so
    // it's safe today. If a future feature needs to preserve per-group
    // customizations, this test will fail and force a redesign.
    refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA);
    fs.writeFileSync(
      path.join(groupCacheA, 'index.ts'),
      'export const VERSION = "between-spawn-customization";\n',
    );

    // Simulate the next container spawn — refresh runs again.
    refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA);

    // Customization is gone, fresh upstream content is back.
    expect(fs.readFileSync(path.join(groupCacheA, 'index.ts'), 'utf-8')).toBe(
      'export const VERSION = "fresh";\n',
    );
  });

  it('is a no-op when the upstream source dir does not exist', () => {
    // The production code passes a hard-coded relative path to the
    // agent-runner src dir; in test environments and edge cases (e.g.
    // running NanoClaw against a checkout that does not contain the
    // container/ subtree) the source may be absent. Helper must not
    // throw — it should leave the cache directory in whatever state it
    // was in (existing or absent).
    fs.rmSync(agentRunnerSrc, { recursive: true });

    expect(() =>
      refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA),
    ).not.toThrow();
    // Cache must not have been created since there was nothing to copy.
    expect(fs.existsSync(groupCacheA)).toBe(false);
  });

  it('idempotent: calling twice with no source changes produces identical result', () => {
    refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA);
    const firstSnapshot = fs
      .readdirSync(groupCacheA)
      .map((f) => ({
        name: f,
        content: fs.readFileSync(path.join(groupCacheA, f), 'utf-8'),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA);
    const secondSnapshot = fs
      .readdirSync(groupCacheA)
      .map((f) => ({
        name: f,
        content: fs.readFileSync(path.join(groupCacheA, f), 'utf-8'),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    expect(secondSnapshot).toEqual(firstSnapshot);
  });

  it('handles nested subdirectories in the upstream source', () => {
    // The agent-runner source is flat today, but the helper uses
    // `cpSync(..., { recursive: true })` so it must correctly handle
    // arbitrary nested structures if a future change adds subdirs.
    fs.mkdirSync(path.join(agentRunnerSrc, 'sub'));
    fs.writeFileSync(
      path.join(agentRunnerSrc, 'sub', 'nested.ts'),
      'export const NESTED = true;\n',
    );

    refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA);

    expect(
      fs.readFileSync(path.join(groupCacheA, 'sub', 'nested.ts'), 'utf-8'),
    ).toBe('export const NESTED = true;\n');
  });

  // --- Atomic-rename safety (Option B fixups from PR #40 code review) ---

  it('cleans up a leftover .new scratch dir from a prior failed refresh', () => {
    // Simulates: a previous refresh attempt died after creating the scratch
    // dir but before completing the swap (e.g., NanoClaw killed mid-rmSync).
    // The next refresh must clean up the leftover scratch and produce a
    // valid cache without surfacing the leftover state to callers.
    const scratchDir = `${groupCacheA}.new`;
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(
      path.join(scratchDir, 'leftover-stale.ts'),
      'export const LEFTOVER_FROM_PRIOR_RUN = true;\n',
    );

    refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA);

    // Cache must contain fresh upstream content.
    expect(
      fs.readFileSync(path.join(groupCacheA, 'index.ts'), 'utf-8'),
    ).toBe('export const VERSION = "fresh";\n');
    // Leftover scratch must be gone.
    expect(fs.existsSync(scratchDir)).toBe(false);
    // Leftover content must NOT have leaked into the cache.
    expect(fs.existsSync(path.join(groupCacheA, 'leftover-stale.ts'))).toBe(
      false,
    );
  });

  it('preserves the existing cache when cpSync fails mid-copy (disk full simulation)', () => {
    // Simulates: cpSync fails partway through (disk full, EIO, permission
    // revocation). The atomic-rename pattern's whole point is that this
    // failure mode does NOT corrupt the existing cache — the next spawn
    // must still be able to use the OLD cache, not a half-copied broken
    // tree. This is the single highest-value hardening from the code review.
    //
    // Realistic failure injection requires `vi.spyOn` because the helper
    // pre-cleans scratchDir with `force: true` (any sentinel we'd plant
    // gets wiped before cpSync runs), and Node's chmod behavior is
    // inconsistent across CI runners. Spy gives us deterministic ENOSPC.
    refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA);
    const goodCacheSnapshot = fs
      .readdirSync(groupCacheA)
      .sort();
    const goodIndexContent = fs.readFileSync(
      path.join(groupCacheA, 'index.ts'),
      'utf-8',
    );

    const cpSyncSpy = vi.spyOn(fs, 'cpSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device, copyfile');
    });

    expect(() =>
      refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA),
    ).toThrow('ENOSPC');

    cpSyncSpy.mockRestore();

    // CRITICAL: the existing cache must be untouched.
    expect(fs.existsSync(groupCacheA)).toBe(true);
    expect(fs.readdirSync(groupCacheA).sort()).toEqual(goodCacheSnapshot);
    expect(
      fs.readFileSync(path.join(groupCacheA, 'index.ts'), 'utf-8'),
    ).toBe(goodIndexContent);

    // No scratch dir should remain on disk after the failure.
    expect(fs.existsSync(`${groupCacheA}.new`)).toBe(false);
  });

  it('cleans up scratch dir on failure so retries do not accumulate state', () => {
    // After a failed refresh, the next attempt must start from a clean
    // slate — no half-baked scratch dir lingering. This protects against
    // a degenerate case where repeated failures pile up scratch dirs and
    // eventually fill the disk.
    refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA);

    const cpSyncSpy = vi
      .spyOn(fs, 'cpSync')
      .mockImplementationOnce(() => {
        throw new Error('EIO: i/o error, copyfile');
      });

    expect(() =>
      refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA),
    ).toThrow('EIO');

    cpSyncSpy.mockRestore();

    // Helper's catch block should have removed any scratch dir. Verify
    // by checking the disk state directly + by running a clean refresh
    // and asserting it succeeds without inheriting any leftover state.
    expect(fs.existsSync(`${groupCacheA}.new`)).toBe(false);

    refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA);
    expect(
      fs.readFileSync(path.join(groupCacheA, 'index.ts'), 'utf-8'),
    ).toBe('export const VERSION = "fresh";\n');
    expect(fs.existsSync(`${groupCacheA}.new`)).toBe(false);
  });

  it('does not throw when the dest directory does not exist (force flag)', () => {
    // Issue #1 from code review: the previous version used
    // `if (existsSync(dest)) rmSync(dest)` — vulnerable to TOCTOU between
    // the existsSync and rmSync if an operator/backup deletes the dir
    // mid-call. The new version drops the existsSync gate and uses
    // `force: true` on rmSync, making the helper resilient to that case.
    expect(fs.existsSync(groupCacheA)).toBe(false);
    expect(() =>
      refreshAgentRunnerSrcCache(agentRunnerSrc, groupCacheA),
    ).not.toThrow();
    expect(fs.existsSync(groupCacheA)).toBe(true);
  });
});
