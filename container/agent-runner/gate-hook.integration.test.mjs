/**
 * Integration tests for createGateHook() — the PreToolUse hook that blocks
 * git commit until an approach message has been posted.
 *
 * Tests the hook callback with real filesystem operations (temp dirs for
 * marker files) and simulated SDK HookInput objects.
 *
 * Cannot import from index.ts (SDK dependency), so we replicate
 * createGateHook logic and test the contract it must satisfy.
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
 * Strengthened: validates marker CONTENT via isApproachContent, not just existence.
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
  const text = messageText ?? 'My approach: implement the feature by creating a new component, reusing the existing utilities, and adding a database migration for the new schema table with proper test coverage.';
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({
    postedAt: new Date().toISOString(),
    textLength: text.length,
    messageText: text,
  }));
}

// --- Tests ---

describe('createGateHook integration', () => {
  let tmpDir;
  let markerPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-hook-test-'));
    markerPath = path.join(tmpDir, 'approach-posted.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('deny path (no marker file)', () => {
    it('denies git commit when marker does not exist', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "fix bug"');

      const result = await hook(input);

      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('Approach not posted');
      expect(result.systemMessage).toContain('send_message');
    });

    it('denies git commit --amend when marker does not exist', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit --amend --no-edit');

      const result = await hook(input);
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('denies git commit in a chained command', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git add . && git commit -m "changes"');

      const result = await hook(input);
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });
  });

  describe('allow path (marker exists)', () => {
    it('allows git commit when marker file exists', async () => {
      writeMarkerFile(markerPath);
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "fix bug"');

      const result = await hook(input);
      expect(result).toEqual({});
    });

    it('marker with empty JSON denies commit', async () => {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, '{}'); // no messageText field
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "test"');

      const result = await hook(input);
      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('marker exists but messageText fails content check — denies commit', async () => {
      const genericMessage = 'Running in parallel on this task, will report back with results soon enough to keep the team updated on all progress made here during this work session today';
      writeMarkerFile(markerPath, genericMessage);
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "feat"');

      const result = await hook(input);
      expect(result.hookSpecificOutput).toBeDefined();
      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    });
  });

  describe('dispatch exemption (isMain=true)', () => {
    it('allows git commit for dispatch even without marker', async () => {
      const hook = createGateHook(true, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "dispatch commit"');

      const result = await hook(input);
      expect(result).toEqual({});
    });

    it('allows git commit for dispatch with marker present too', async () => {
      writeMarkerFile(markerPath);
      const hook = createGateHook(true, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "dispatch commit"');

      const result = await hook(input);
      expect(result).toEqual({});
    });
  });

  describe('tool filtering (non-Bash tools pass through)', () => {
    it('allows Read tool without marker', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Read', '/some/file.ts');

      const result = await hook(input);
      expect(result).toEqual({});
    });

    it('allows Write tool without marker', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Write', '/some/file.ts');

      const result = await hook(input);
      expect(result).toEqual({});
    });

    it('allows Edit tool without marker', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Edit', '/some/file.ts');

      const result = await hook(input);
      expect(result).toEqual({});
    });

    it('allows Grep tool without marker', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Grep', 'search pattern');

      const result = await hook(input);
      expect(result).toEqual({});
    });
  });

  describe('command filtering (non-commit Bash commands pass through)', () => {
    it('allows git status without marker', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git status');

      const result = await hook(input);
      expect(result).toEqual({});
    });

    it('allows git diff without marker', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git diff HEAD');

      const result = await hook(input);
      expect(result).toEqual({});
    });

    it('allows npm test without marker', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'npm test');

      const result = await hook(input);
      expect(result).toEqual({});
    });

    it('allows git push without marker', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git push origin main');

      const result = await hook(input);
      expect(result).toEqual({});
    });

    it('allows ls and file operations without marker', async () => {
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'ls -la /workspace/src');

      const result = await hook(input);
      expect(result).toEqual({});
    });
  });

  describe('event filtering (non-PreToolUse events pass through)', () => {
    it('allows PreCompact events without marker', async () => {
      const hook = createGateHook(false, markerPath);
      const input = {
        hook_event_name: 'PreCompact',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
      };

      const result = await hook(input);
      expect(result).toEqual({});
    });
  });
});
