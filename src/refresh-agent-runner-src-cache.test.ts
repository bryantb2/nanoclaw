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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    groupCacheA = path.join(tmpRoot, 'sessions', 'slack_groupA', 'agent-runner-src');
    groupCacheB = path.join(tmpRoot, 'sessions', 'slack_groupB', 'agent-runner-src');

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
    expect(
      fs.readFileSync(path.join(groupCacheA, 'index.ts'), 'utf-8'),
    ).toBe('export const VERSION = "fresh";\n');
    expect(
      fs.readFileSync(path.join(groupCacheA, 'helper.ts'), 'utf-8'),
    ).toBe('export function helper(): string { return "fresh"; }\n');
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
    expect(
      fs.readFileSync(path.join(groupCacheA, 'index.ts'), 'utf-8'),
    ).toBe('export const VERSION = "fresh";\n');
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
    expect(
      fs.readFileSync(path.join(groupCacheA, 'index.ts'), 'utf-8'),
    ).toBe('export const VERSION = "agentA-customized";\n');
    expect(
      fs.readFileSync(path.join(groupCacheB, 'index.ts'), 'utf-8'),
    ).toBe('export const VERSION = "fresh";\n');
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
    expect(
      fs.readFileSync(path.join(groupCacheA, 'index.ts'), 'utf-8'),
    ).toBe('export const VERSION = "fresh";\n');
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
});
