/**
 * Tests for createTestGateHook() and validateTestPassedMarker() gate logic.
 *
 * The actual createTestGateHook() and validateTestPassedMarker() live in
 * container/agent-runner/src/index.ts which cannot be imported here
 * (depends on @anthropic-ai/claude-agent-sdk).
 * This test replicates the logic verbatim to verify behavior.
 * If the source changes, this replica must be updated too.
 *
 * Pattern follows gate-logic.test.mjs and gate-hook.integration.test.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// --- Replicated gate logic (must stay in sync with index.ts) ---

/**
 * Validates the test-passed.json marker file content.
 * Returns true only if:
 *   - passed === true
 *   - coverageAfter is a number (required field)
 *   - coverageDelta, if present, is >= 0 (no coverage regression)
 */
export function validateTestPassedMarker(markerPath) {
  try {
    const data = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
    if (data.passed !== true) return false;
    if (typeof data.coverageAfter !== 'number') return false;
    if (typeof data.coverageDelta === 'number' && data.coverageDelta < 0) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Replicated createTestGateHook — uses a configurable marker path (instead of
 * the hardcoded /workspace/ipc/test-passed.json) so tests can use temp dirs.
 *
 * Blocks `gh pr create` commands unless a valid test-passed.json marker exists.
 * Dispatch group (isMain=true) is always exempt (D-04).
 */
export function createTestGateHook(isMain, markerPath) {
  return async (input) => {
    if (isMain) return {};  // D-04: dispatch exempt
    if (input.hook_event_name !== 'PreToolUse') return {};

    const toolName = input.tool_name;
    if (toolName !== 'Bash') return {};

    const command = input.tool_input?.command ?? '';
    if (!command.includes('gh pr create')) return {};

    if (fs.existsSync(markerPath) && validateTestPassedMarker(markerPath)) return {};

    return {
      systemMessage: 'You must run tests and ensure coverage does not regress before creating a PR. Run the test suite, capture before/after coverage, and write test-passed.json to /workspace/ipc/ with: { "passed": true, "testCount": N, "failCount": 0, "coverageBefore": X, "coverageAfter": Y, "coverageDelta": D, "passedAt": "ISO timestamp" }',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Tests not passed or coverage regressed. Run tests, verify coverage >= baseline, write /workspace/ipc/test-passed.json.',
      },
    };
  };
}

// --- Test helpers ---

function makePreToolUseInput(toolName, command) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { command },
  };
}

function writeValidMarker(markerPath, overrides = {}) {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const marker = {
    passed: true,
    testCount: 42,
    failCount: 0,
    coverageBefore: 80.0,
    coverageAfter: 82.3,
    coverageDelta: 2.3,
    passedAt: new Date().toISOString(),
    ...overrides,
  };
  fs.writeFileSync(markerPath, JSON.stringify(marker));
}

// --- Tests ---

describe('createTestGateHook', () => {
  let tmpDir;
  let markerPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gate-test-'));
    markerPath = path.join(tmpDir, 'test-passed.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 1
  it('returns {} (allow) when isMain=true (dispatch exempt, D-04)', async () => {
    const hook = createTestGateHook(true, markerPath);
    const input = makePreToolUseInput('Bash', 'gh pr create --title "feat: add login"');

    const result = await hook(input);
    expect(result).toEqual({});
  });

  // Test 2
  it('returns {} when hook_event_name is not PreToolUse', async () => {
    const hook = createTestGateHook(false, markerPath);
    const input = {
      hook_event_name: 'PreCompact',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title "feat: add login"' },
    };

    const result = await hook(input);
    expect(result).toEqual({});
  });

  // Test 3
  it('returns {} when tool_name is not Bash', async () => {
    const hook = createTestGateHook(false, markerPath);
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { command: 'gh pr create --title "feat: add login"' },
    };

    const result = await hook(input);
    expect(result).toEqual({});
  });

  // Test 4
  it('returns {} when command does not contain gh pr create', async () => {
    const hook = createTestGateHook(false, markerPath);
    const input = makePreToolUseInput('Bash', 'git commit -m "fix bug"');

    const result = await hook(input);
    expect(result).toEqual({});
  });

  // Test 5
  it('returns deny when command contains gh pr create and no marker file exists', async () => {
    const hook = createTestGateHook(false, markerPath);
    const input = makePreToolUseInput('Bash', 'gh pr create --title "feat: add login" --body "desc"');

    const result = await hook(input);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('test-passed.json');
    expect(result.systemMessage).toContain('test-passed.json');
  });

  // Test 6
  it('returns {} (allow) when command contains gh pr create and valid test-passed.json marker exists', async () => {
    writeValidMarker(markerPath);
    const hook = createTestGateHook(false, markerPath);
    const input = makePreToolUseInput('Bash', 'gh pr create --title "feat: add login"');

    const result = await hook(input);
    expect(result).toEqual({});
  });

  // Test 7
  it('returns deny when marker exists but has coverageDelta < 0 (coverage regression)', async () => {
    writeValidMarker(markerPath, {
      coverageBefore: 85.0,
      coverageAfter: 82.0,
      coverageDelta: -3.0,
    });
    const hook = createTestGateHook(false, markerPath);
    const input = makePreToolUseInput('Bash', 'gh pr create --title "feat: add login"');

    const result = await hook(input);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  // Test 8
  it('returns {} when marker has coverageDelta >= 0 (no regression — positive delta)', async () => {
    writeValidMarker(markerPath, {
      coverageBefore: 80.0,
      coverageAfter: 83.5,
      coverageDelta: 3.5,
    });
    const hook = createTestGateHook(false, markerPath);
    const input = makePreToolUseInput('Bash', 'gh pr create --title "feat: add login"');

    const result = await hook(input);
    expect(result).toEqual({});
  });

  // Test 9
  it('returns {} when marker has coverageDelta = 0 (exact same coverage is OK)', async () => {
    writeValidMarker(markerPath, {
      coverageBefore: 82.0,
      coverageAfter: 82.0,
      coverageDelta: 0,
    });
    const hook = createTestGateHook(false, markerPath);
    const input = makePreToolUseInput('Bash', 'gh pr create --title "feat: add login"');

    const result = await hook(input);
    expect(result).toEqual({});
  });

  // Test 10
  it('handles full gh pr create command with title and body flags', async () => {
    writeValidMarker(markerPath);
    const hook = createTestGateHook(false, markerPath);
    const input = makePreToolUseInput('Bash', 'gh pr create --title "foo" --body "bar"');

    const result = await hook(input);
    expect(result).toEqual({});
  });
});

describe('validateTestPassedMarker', () => {
  let tmpDir;
  let markerPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gate-validate-'));
    markerPath = path.join(tmpDir, 'test-passed.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 11
  it('returns false for missing required fields (passed, coverageAfter)', () => {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({
      testCount: 42,
      passedAt: new Date().toISOString(),
      // missing: passed, coverageAfter
    }));

    expect(validateTestPassedMarker(markerPath)).toBe(false);
  });

  // Test 12
  it('returns false for passed=false', () => {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({
      passed: false,
      testCount: 42,
      failCount: 2,
      coverageAfter: 80.0,
      passedAt: new Date().toISOString(),
    }));

    expect(validateTestPassedMarker(markerPath)).toBe(false);
  });

  it('returns false when file does not exist', () => {
    expect(validateTestPassedMarker('/nonexistent/test-passed.json')).toBe(false);
  });

  it('returns false when file contains invalid JSON', () => {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, 'not-json{{{');

    expect(validateTestPassedMarker(markerPath)).toBe(false);
  });

  it('returns true for a valid marker with all recommended fields', () => {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({
      passed: true,
      testCount: 55,
      failCount: 0,
      coverageBefore: 78.5,
      coverageAfter: 80.1,
      coverageDelta: 1.6,
      passedAt: new Date().toISOString(),
    }));

    expect(validateTestPassedMarker(markerPath)).toBe(true);
  });

  it('returns true for a marker with only required fields (passed + coverageAfter)', () => {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({
      passed: true,
      coverageAfter: 80.0,
    }));

    expect(validateTestPassedMarker(markerPath)).toBe(true);
  });
});
