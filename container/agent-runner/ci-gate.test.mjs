/**
 * Tests for CI gate hook logic: extractPrNumber, parseCheckResults, createCiGateHook.
 *
 * The actual createCiGateHook() lives in container/agent-runner/src/index.ts which
 * cannot be imported here (depends on @anthropic-ai/claude-agent-sdk).
 * This test replicates the logic verbatim (with a mockable execFn) to verify behavior.
 * If the source changes, this replica must be updated too.
 *
 * Pattern follows gate-logic.test.mjs and test-gate.test.mjs.
 */
import { describe, it, expect, vi } from 'vitest';

// --- Replicated gate logic (must stay in sync with index.ts) ---

/**
 * Extract a PR number from a `gh pr merge` command.
 * Returns null when no explicit number is provided (current-branch PR).
 *
 * Examples:
 *   'gh pr merge 42'                        → 42
 *   'gh pr merge --squash 42'               → 42
 *   'gh pr merge --squash --delete-branch 42' → 42
 *   'gh pr merge 42 --squash'               → 42
 *   'gh pr merge'                           → null
 *   'gh pr merge --squash'                  → null
 */
export function extractPrNumber(command) {
  // Match number anywhere after 'gh pr merge' (with optional flags before/after)
  const match = command.match(/gh\s+pr\s+merge(?:\s+--\S+)*\s+(\d+)/);
  if (match) return parseInt(match[1], 10);
  // Also try number appearing before flags: 'gh pr merge 42 --squash'
  const trailingMatch = command.match(/gh\s+pr\s+merge\s+(\d+)/);
  if (trailingMatch) return parseInt(trailingMatch[1], 10);
  return null;
}

/**
 * Parse `gh pr checks --json name,status,conclusion` output.
 * SKIPPED and NEUTRAL conclusions are treated as passed (same as SUCCESS).
 */
export function parseCheckResults(checks) {
  const allDone = checks.every(c => c.status === 'COMPLETED');
  const allPassed = allDone && checks.every(
    c => c.conclusion === 'SUCCESS' || c.conclusion === 'SKIPPED' || c.conclusion === 'NEUTRAL'
  );
  return { allDone, allPassed };
}

/**
 * Replicated createCiGateHook — accepts a mockable execFn for testing.
 * Production version uses promisify(exec) from 'child_process'.
 *
 * Blocks `gh pr merge` unless all CI checks pass.
 * Dispatch group (isMain=true) is exempt.
 * On infrastructure error (gh CLI fails), allows merge (fail-open).
 */
export function createCiGateHook(isMain, execFn, timeoutMs = 600_000) {
  // timeoutMs parameter mirrors production's CI_CHECK_TIMEOUT_MS env var (default 600000)
  const pollIntervalMs = 30_000;

  return async (input) => {
    if (isMain) return {};  // dispatch exempt
    if (input.hook_event_name !== 'PreToolUse') return {};

    const toolName = input.tool_name;
    if (toolName !== 'Bash') return {};

    const command = input.tool_input?.command ?? '';
    if (!command.includes('gh pr merge')) return {};

    const prNumber = extractPrNumber(command);
    const repoMatch = command.match(/--repo\s+(\S+)/);
    const repoFlag = repoMatch ? `--repo ${repoMatch[1]}` : '';
    const prArg = prNumber != null ? String(prNumber) : '';

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const { stdout } = await execFn(
          `gh pr checks ${prArg} ${repoFlag} --json name,status,conclusion`.trim()
        );
        const checks = JSON.parse(stdout);
        const { allDone, allPassed } = parseCheckResults(checks);

        if (allDone) {
          if (allPassed) return {};  // allow merge
          const failing = checks
            .filter(c => c.conclusion !== 'SUCCESS' && c.conclusion !== 'SKIPPED' && c.conclusion !== 'NEUTRAL')
            .map(c => c.name)
            .join(', ');
          return {
            systemMessage: `CI checks failed. Do not merge this PR. Review the failing checks and fix them first.`,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `CI checks failed: ${failing}`,
            },
          };
        }

        // CI still running — poll
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      } catch (_err) {
        // gh CLI failed (no checks configured, network error, etc.)
        // Fail-open: allow merge and log warning
        return {};
      }
    }

    // Timeout expired
    return {
      systemMessage: `CI checks timed out after ${timeoutMs / 1000}s. Post the CI status to Slack and do NOT merge. Wait for CI to complete or investigate why checks are stuck.`,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `CI checks still running after ${timeoutMs / 1000}s timeout. Post status to Slack.`,
      },
    };
  };
}

// --- Helpers ---

function makePreToolUseInput(toolName, command) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { command },
  };
}

function makeChecks(overrides = []) {
  // Default: single SUCCESS check
  if (overrides.length > 0) return overrides;
  return [{ name: 'ci/test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
}

function mockExec(checks) {
  return vi.fn().mockResolvedValue({ stdout: JSON.stringify(checks) });
}

// --- Tests ---

describe('extractPrNumber', () => {
  // Test 1
  it('extracts number from simple gh pr merge N', () => {
    expect(extractPrNumber('gh pr merge 42')).toBe(42);
  });

  // Test 2
  it('extracts number from gh pr merge --squash N', () => {
    expect(extractPrNumber('gh pr merge --squash 42')).toBe(42);
  });

  // Test 3
  it('extracts number from gh pr merge --squash --delete-branch N', () => {
    expect(extractPrNumber('gh pr merge --squash --delete-branch 42')).toBe(42);
  });

  // Test 4
  it('extracts number when number comes before flags: gh pr merge N --squash', () => {
    expect(extractPrNumber('gh pr merge 42 --squash')).toBe(42);
  });

  // Test 5
  it('returns null for gh pr merge with no number (current branch PR)', () => {
    expect(extractPrNumber('gh pr merge')).toBeNull();
  });

  // Test 6
  it('returns null for gh pr merge --squash with no number', () => {
    expect(extractPrNumber('gh pr merge --squash')).toBeNull();
  });
});

describe('parseCheckResults', () => {
  // Test 7
  it('returns allDone=true, allPassed=true when all COMPLETED+SUCCESS', () => {
    const checks = [
      { name: 'ci/test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'ci/lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ];
    expect(parseCheckResults(checks)).toEqual({ allDone: true, allPassed: true });
  });

  // Test 8
  it('returns allDone=true, allPassed=false when one COMPLETED+FAILURE', () => {
    const checks = [
      { name: 'ci/test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'ci/lint', status: 'COMPLETED', conclusion: 'FAILURE' },
    ];
    expect(parseCheckResults(checks)).toEqual({ allDone: true, allPassed: false });
  });

  // Test 9
  it('returns allDone=false, allPassed=false when one IN_PROGRESS', () => {
    const checks = [
      { name: 'ci/test', status: 'IN_PROGRESS', conclusion: null },
      { name: 'ci/lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ];
    expect(parseCheckResults(checks)).toEqual({ allDone: false, allPassed: false });
  });

  // Test 10
  it('treats COMPLETED+SKIPPED as passed', () => {
    const checks = [
      { name: 'ci/test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'ci/optional', status: 'COMPLETED', conclusion: 'SKIPPED' },
    ];
    expect(parseCheckResults(checks)).toEqual({ allDone: true, allPassed: true });
  });
});

describe('createCiGateHook', () => {
  // Test 11
  it('returns {} (allow) when isMain=true (dispatch exempt)', async () => {
    const exec = mockExec([]);
    const hook = createCiGateHook(true, exec);
    const input = makePreToolUseInput('Bash', 'gh pr merge 42 --squash');

    const result = await hook(input);
    expect(result).toEqual({});
    expect(exec).not.toHaveBeenCalled();
  });

  // Test 12
  it('returns {} when command does not contain gh pr merge', async () => {
    const exec = mockExec([]);
    const hook = createCiGateHook(false, exec);
    const input = makePreToolUseInput('Bash', 'git push origin main');

    const result = await hook(input);
    expect(result).toEqual({});
    expect(exec).not.toHaveBeenCalled();
  });

  // Test 13
  it('returns deny when command contains gh pr merge and checks fail', async () => {
    const checks = [
      { name: 'ci/test', status: 'COMPLETED', conclusion: 'FAILURE' },
    ];
    const exec = mockExec(checks);
    const hook = createCiGateHook(false, exec);
    const input = makePreToolUseInput('Bash', 'gh pr merge 42 --squash');

    const result = await hook(input);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('ci/test');
    expect(result.systemMessage).toContain('CI checks failed');
  });

  // Test 14
  it('returns {} (allow) when all checks pass', async () => {
    const checks = [
      { name: 'ci/test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'ci/lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ];
    const exec = mockExec(checks);
    const hook = createCiGateHook(false, exec);
    const input = makePreToolUseInput('Bash', 'gh pr merge 42 --squash');

    const result = await hook(input);
    expect(result).toEqual({});
  });
});
