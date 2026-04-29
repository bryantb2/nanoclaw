/**
 * Tests for isApproachContent() and the strengthened createGateHook() gate logic.
 *
 * The actual isApproachContent() and createGateHook() live in
 * container/agent-runner/src/index.ts which cannot be imported here
 * (depends on @anthropic-ai/claude-agent-sdk).
 * This test replicates the logic verbatim to verify behavior.
 * If the source changes, this replica must be updated too.
 *
 * Pattern follows test-gate.test.mjs and gate-hook.integration.test.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// --- Replicated gate logic (must stay in sync with index.ts) ---

const APPROACH_BLOCKLIST = ["on it", "confirmed", "working on this", "acknowledged", "queued"];

const APPROACH_INDICATORS = [
  "plan", "approach", "implement", "change", "add", "modify",
  "create", "refactor", "update", "build", "reuse", "extend",
  "integrate", "wire", "connect", "route", "endpoint", "component",
  "schema", "migration", "model", "api", "database", "ui",
  "test", "fix", "replace", "remove", "extract", "split",
  "merge", "configure", "deploy", "hook", "gate", "validate"
];

function isSubstantiveApproach(text) {
  if (text.length <= 100) return false;
  const lower = text.toLowerCase();
  return !APPROACH_BLOCKLIST.some(phrase => lower.includes(phrase));
}

/**
 * Replicated isApproachContent — goes beyond isSubstantiveApproach by requiring
 * at least 2 approach-specific indicator words.
 */
function isApproachContent(text) {
  if (!isSubstantiveApproach(text)) return false;
  const words = text.toLowerCase().split(/[\s.,;:!?()\[\]{}"'`\/\\]+/).filter(Boolean);
  const matchCount = APPROACH_INDICATORS.filter(ind => words.includes(ind)).length;
  return matchCount >= 2;
}

/**
 * Replicated createGateHook — uses a configurable marker path (instead of
 * the hardcoded /workspace/ipc/approach-posted.json) so tests can use temp dirs.
 *
 * Strengthened to validate marker CONTENT, not just existence.
 */
function createGateHook(isMain, markerPath) {
  return async (input) => {
    if (isMain) return {};
    if (input.hook_event_name !== 'PreToolUse') return {};

    const toolName = input.tool_name;
    if (toolName !== 'Bash') return {};

    const command = input.tool_input?.command ?? '';
    if (!command.includes('git commit')) return {};

    try {
      const data = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
      if (typeof data.messageText === 'string' && isApproachContent(data.messageText)) return {};
    } catch { /* marker missing or invalid — fall through to deny */ }

    return {
      systemMessage: 'You must post your implementation approach to Slack via send_message before committing. The message must describe: (a) what you plan to build or change, (b) which existing patterns you will reuse, (c) how it fits the architecture. Generic acknowledgments or progress updates do not satisfy this gate.',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Approach not posted or message did not contain implementation specifics. Call send_message describing your approach (what, how, which patterns) first.',
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

function writeMarkerFile(markerPath, messageText) {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({
    postedAt: new Date().toISOString(),
    textLength: messageText.length,
    messageText,
  }));
}

// --- isApproachContent tests ---

describe('isApproachContent', () => {
  // Test 1
  it('returns true for a message with implementation specifics (implement + reuse + component + route)', () => {
    const text = 'I will implement the login page by adding a new route at /auth/login, reusing the existing AuthForm component and adding password validation';
    expect(isApproachContent(text)).toBe(true);
  });

  // Test 2
  it('returns true for a message describing a plan with technical specifics (approach + change + database)', () => {
    const text = 'My approach: change the dashboard to use a new database query that aggregates commitment data by week, then update the chart component to render the weekly view instead of daily view with proper filtering and pagination support for large datasets';
    expect(isApproachContent(text)).toBe(true);
  });

  // Test 3
  it('returns false for generic progress update padded to >100 chars (no approach indicators)', () => {
    const text = 'Running in parallel on this task, will report back with results soon enough to meet the deadline here and keep everyone posted';
    expect(isApproachContent(text)).toBe(false);
  });

  // Test 4
  it('returns false for a completion report padded to >100 chars (no approach indicators)', () => {
    const text = 'Done. 1 PR opened: KRE-245 — PR #119 — CI: passing, 675 tests. Everything looks good on the latest run with no failures or regressions.';
    expect(isApproachContent(text)).toBe(false);
  });

  // Test 5
  it('returns false for an exploration report padded to >100 chars (no approach indicators)', () => {
    const text = 'I have read the codebase thoroughly and found the relevant patterns for this change. Will continue investigating further before proceeding.';
    expect(isApproachContent(text)).toBe(false);
  });

  // Test 6
  it('returns false for text <= 100 chars regardless of content', () => {
    const text = 'implement the feature by creating a new component and adding a route';
    expect(text.length).toBeLessThanOrEqual(100);
    expect(isApproachContent(text)).toBe(false);
  });

  // Test 7
  it('returns false for blocklisted phrase "on it" even if text is long and has indicators', () => {
    const text = 'On it — I will implement the login page by adding a new route at /auth/login and reusing the existing component with proper validation and test coverage for all edge cases';
    expect(isApproachContent(text)).toBe(false);
  });

  // Test 8
  it('returns false for blocklisted phrase "confirmed" even if text has approach specifics', () => {
    const text = 'Confirmed — my plan is to implement the feature by creating a new component and updating the database schema to add the required fields with proper migration scripts';
    expect(isApproachContent(text)).toBe(false);
  });

  // Test 9
  it('returns true for text with exactly 2 approach indicators (plan + implement)', () => {
    const text = 'My plan is to implement this feature by reading the existing utilities and adapting them to fit our new requirements properly within the project structure as needed';
    expect(isApproachContent(text)).toBe(true);
  });

  // Test 10
  it('returns false for text with only 1 approach indicator (implement) even if >100 chars', () => {
    const text = 'I will implement the thing here in this codebase project for the feature requested by the user in the current context and scope of the work being done here today';
    // "implement" is 1 indicator but no other indicators appear as full words
    const words = text.toLowerCase().split(/[\s.,;:!?()\[\]{}"'`\/\\]+/).filter(Boolean);
    const matchCount = APPROACH_INDICATORS.filter(ind => words.includes(ind)).length;
    expect(matchCount).toBeLessThan(2);
    expect(isApproachContent(text)).toBe(false);
  });

  // Test 11
  it('uses word-boundary matching — "schema" in "schematic" does not count', () => {
    // "schematic" should not match "schema" indicator
    const text = 'I will review the schematic documentation and write a detailed schematic breakdown for this project component structure here in our current codebase version';
    // "component" is 1 indicator; "schema" is not matched inside "schematic"
    const words = text.toLowerCase().split(/[\s.,;:!?()\[\]{}"'`\/\\]+/).filter(Boolean);
    const matchCount = APPROACH_INDICATORS.filter(ind => words.includes(ind)).length;
    // "component" matches, but "schema" should NOT match from "schematic"
    expect(words.includes('schema')).toBe(false);
    expect(words.includes('schematic')).toBe(true);
    expect(matchCount).toBeLessThan(2);
    expect(isApproachContent(text)).toBe(false);
  });

  // Test 12
  it('returns true for text with many approach indicators', () => {
    const text = 'My approach: I will create a new API endpoint, add the database schema migration, update the model, implement the route handler, and build the UI component with proper test coverage. I will reuse the existing validation utilities and extend the base controller class as needed.';
    expect(isApproachContent(text)).toBe(true);
  });

  // Test 13
  it('handles case-insensitivity — "IMPLEMENT" and "PLAN" count as indicators', () => {
    const text = 'My PLAN is to IMPLEMENT this feature by reading the existing utilities and adapting them carefully to fit the current architecture structure and requirements of the system here';
    expect(isApproachContent(text)).toBe(true);
  });

  // Test 14
  it('returns false for "working on this" blocklist phrase with indicators', () => {
    const text = 'Working on this now — my plan is to implement and build the new component with proper schema migration and test coverage to avoid any regressions in the codebase';
    expect(isApproachContent(text)).toBe(false);
  });

  // Test 15
  it('returns false for text exactly at the 100-char boundary (length <= 100)', () => {
    // "implement" + "plan" (2 indicators) but exactly 100 chars — should fail the length check
    const base = 'My plan is to implement this feature ';
    const text = base + 'x'.repeat(100 - base.length);
    expect(text.length).toBe(100);
    expect(isApproachContent(text)).toBe(false);
  });
});

// --- Strengthened createGateHook tests ---

describe('createGateHook (strengthened — content validation)', () => {
  let tmpDir;
  let markerPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approach-gate-test-'));
    markerPath = path.join(tmpDir, 'approach-posted.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('deny path — no marker or invalid marker content', () => {
    // Test 16
    it('denies git commit when marker does not exist', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "feat: add login"');

      const result = await hook(input);
      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    // Test 17
    it('denies git commit when marker exists but has no messageText field (legacy format)', async () => {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({
        postedAt: new Date().toISOString(),
        textLength: 150,
        // no messageText field — legacy format
      }));
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "feat: add login"');

      const result = await hook(input);
      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    // Test 18
    it('denies git commit when marker exists but messageText fails content check (generic progress update)', async () => {
      const genericMessage = 'Running in parallel on this task, will report back with results soon enough to keep the team updated on progress here';
      writeMarkerFile(markerPath, genericMessage);
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "feat: add login"');

      const result = await hook(input);
      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    // Test 19
    it('denies git commit when marker is empty JSON ({}) — no messageText field', async () => {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, '{}');
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "test"');

      const result = await hook(input);
      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    // Test 20
    it('denies git commit when marker has messageText that is too short (<= 100 chars)', async () => {
      writeMarkerFile(markerPath, 'I will implement the feature.');
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "feat"');

      const result = await hook(input);
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    // Test 21
    it('denies git commit when marker has messageText with blocklisted phrase', async () => {
      const blocklisted = 'Confirmed — here is my detailed plan for the implementation with all the necessary changes and steps clearly listed for the team to review fully';
      writeMarkerFile(markerPath, blocklisted);
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "feat"');

      const result = await hook(input);
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    // Test 22
    it('deny systemMessage contains the 3-part requirement (a), (b), (c)', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "feat"');

      const result = await hook(input);
      expect(result.systemMessage).toContain('(a) what you plan to build or change');
      expect(result.systemMessage).toContain('(b) which existing patterns you will reuse');
      expect(result.systemMessage).toContain('(c) how it fits the architecture');
    });

    // Test 23
    it('denies git commit --amend when marker is missing', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit --amend --no-edit');

      const result = await hook(input);
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    // Test 24
    it('denies git commit in a chained command when marker content fails', async () => {
      const genericMessage = 'Running in parallel on this task, will report back soon enough to keep the team posted about all the progress made here during this work session';
      writeMarkerFile(markerPath, genericMessage);
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git add . && git commit -m "changes"');

      const result = await hook(input);
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });
  });

  describe('allow path — valid marker with qualifying approach content', () => {
    // Test 25
    it('allows git commit when marker has messageText that passes content check', async () => {
      const approach = 'My approach: implement the feature by creating a new component at components/Login.tsx, reusing the existing AuthForm component and adding route /auth/login. Will extend the base controller and add database migration for the new user_sessions table.';
      writeMarkerFile(markerPath, approach);
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "feat: implement login"');

      const result = await hook(input);
      expect(result).toEqual({});
    });

    // Test 26
    it('allows git commit with minimal qualifying approach (plan + implement, >100 chars)', async () => {
      const approach = 'My plan is to implement this feature by reading the existing utilities and adapting them to fit the new requirements of the current architecture correctly';
      writeMarkerFile(markerPath, approach);
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "feat"');

      const result = await hook(input);
      expect(result).toEqual({});
    });
  });

  describe('dispatch exemption (isMain=true)', () => {
    // Test 27
    it('allows git commit for dispatch even without marker (isMain=true)', async () => {
      const hook = createGateHook(true, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "dispatch commit"');

      const result = await hook(input);
      expect(result).toEqual({});
    });

    // Test 28
    it('allows git commit for dispatch with empty JSON marker (isMain=true)', async () => {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, '{}');
      const hook = createGateHook(true, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "dispatch commit"');

      const result = await hook(input);
      expect(result).toEqual({});
    });
  });

  describe('tool and command filtering (gate is bypass-proof)', () => {
    // Test 29
    it('allows Read tool without marker (only Bash is gated)', async () => {
      const hook = createGateHook(false, markerPath);
      const result = await hook(makePreToolUseInput('Read', '/some/file.ts'));
      expect(result).toEqual({});
    });

    // Test 30
    it('allows git status without marker (only git commit is gated)', async () => {
      const hook = createGateHook(false, markerPath);
      const result = await hook(makePreToolUseInput('Bash', 'git status'));
      expect(result).toEqual({});
    });

    // Test 31
    it('allows git push without marker (only git commit is gated)', async () => {
      const hook = createGateHook(false, markerPath);
      const result = await hook(makePreToolUseInput('Bash', 'git push origin main'));
      expect(result).toEqual({});
    });

    // Test 32 — non-PreToolUse events pass through
    it('allows PreCompact events without marker', async () => {
      const hook = createGateHook(false, markerPath);
      const result = await hook({
        hook_event_name: 'PreCompact',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
      });
      expect(result).toEqual({});
    });
  });
});
