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

// --- Replicated gate logic (must stay in sync with index.ts lines 258-291) ---

const APPROACH_BLOCKLIST = ["on it", "confirmed", "working on this", "acknowledged", "queued"];

function isSubstantiveApproach(text) {
  if (text.length <= 100) return false;
  const lower = text.toLowerCase();
  return !APPROACH_BLOCKLIST.some(phrase => lower.includes(phrase));
}

/**
 * Replicated createGateHook — uses a configurable marker path (instead of
 * the hardcoded /workspace/ipc/approach-posted.json) so tests can use temp dirs.
 */
function createGateHook(isMain, markerPath) {
  return async (input) => {
    if (isMain) return {};
    if (input.hook_event_name !== 'PreToolUse') return {};

    const toolName = input.tool_name;
    if (toolName !== 'Bash') return {};

    const command = input.tool_input?.command ?? '';
    if (!command.includes('git commit')) return {};

    if (fs.existsSync(markerPath)) return {};

    return {
      systemMessage: 'You must post your implementation approach to Slack via send_message before writing any code. The message must be >100 characters and describe what you plan to do.',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Approach not posted. Call send_message with your implementation plan (>100 chars) first.',
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

function writeMarkerFile(markerPath) {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({
    postedAt: new Date().toISOString(),
    textLength: 150,
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

    it('marker content is irrelevant — only existence matters', async () => {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, '{}'); // minimal content
      const hook = createGateHook(false, markerPath);
      const input = makePreToolUseInput('Bash', 'git commit -m "test"');

      const result = await hook(input);
      expect(result).toEqual({});
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
