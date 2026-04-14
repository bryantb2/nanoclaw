/**
 * Tests for QA evidence gate logic.
 *
 * The actual createQaEvidenceGateHook() lives in
 * container/agent-runner/src/index.ts which cannot be imported here
 * (depends on @anthropic-ai/claude-agent-sdk).
 * This test replicates the logic verbatim to verify behavior.
 * If the source changes, this replica must be updated too.
 *
 * Pattern follows gate-logic.test.mjs, test-gate.test.mjs, and ci-gate.test.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// --- Replicated gate logic (must stay in sync with index.ts) ---

const REQUIRED_FILES_ALWAYS = ['test-logs.json', 'coverage-delta.json', 'verification-notes.json'];
const FRONTEND_EXTENSIONS = ['.tsx', '.jsx', '.css', '.html'];

/**
 * Returns true if any file in changedFiles ends with a frontend extension.
 */
export function isFrontendChange(changedFiles) {
  return changedFiles.some(f => FRONTEND_EXTENSIONS.some(ext => f.endsWith(ext)));
}

/**
 * Returns the list of required evidence files for this PR.
 * Screenshots are only required when frontend files are changed.
 */
export function getRequiredEvidenceFiles(isFrontend) {
  return isFrontend
    ? [...REQUIRED_FILES_ALWAYS, 'screenshots.json']
    : [...REQUIRED_FILES_ALWAYS];
}

/**
 * Checks which required evidence files are present in evidenceDir.
 * Returns { complete: true } or { complete: false, missing: [...] }.
 */
export function checkQaEvidence(evidenceDir, isFrontend) {
  const required = getRequiredEvidenceFiles(isFrontend);
  const missing = required.filter(f => !fs.existsSync(path.join(evidenceDir, f)));
  return { complete: missing.length === 0, missing };
}

/**
 * Replicated createQaEvidenceGateHook — uses a configurable evidence dir and
 * execFn (instead of hardcoded paths) so tests can use temp dirs and mock exec.
 *
 * Intercepts `gh pr review --approve` commands and blocks approval unless all
 * required evidence files exist in evidenceDir.
 * Dispatch group (isMain=true) is always exempt.
 */
export function createQaEvidenceGateHook(isMain, evidenceDir, execFn) {
  return async (input) => {
    if (isMain) return {};  // dispatch exempt
    if (input.hook_event_name !== 'PreToolUse') return {};

    const toolName = input.tool_name;
    if (toolName !== 'Bash') return {};

    const command = input.tool_input?.command ?? '';
    if (!command.includes('gh pr review')) return {};
    if (!command.includes('--approve')) return {};

    // Detect frontend changes
    let isFrontend = false;
    try {
      const result = await execFn('git diff --name-only origin/master...HEAD');
      const stdout = typeof result === 'string' ? result : result.stdout;
      const changedFiles = stdout.trim().split('\n').filter(Boolean);
      isFrontend = isFrontendChange(changedFiles);
    } catch {
      // If git diff fails, assume non-frontend (conservative)
    }

    const { complete, missing } = checkQaEvidence(evidenceDir, isFrontend);

    if (complete) return {};  // all evidence present

    return {
      systemMessage: `QA evidence incomplete. Before approving this PR, you must produce the following evidence files in /workspace/ipc/qa-evidence/: ${missing.join(', ')}. Write each file as JSON with the required structure.`,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Missing QA evidence files: ${missing.join(', ')}`,
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

function writeEvidenceFile(dir, filename, content = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(content));
}

function writeAllRequiredFiles(dir, includeFrontend = false) {
  fs.mkdirSync(dir, { recursive: true });
  writeEvidenceFile(dir, 'test-logs.json', { passCount: 42, failCount: 0, failures: [] });
  writeEvidenceFile(dir, 'coverage-delta.json', { before: 82.3, after: 83.1, delta: 0.8 });
  writeEvidenceFile(dir, 'verification-notes.json', { notes: 'Tested login flow', testedAt: new Date().toISOString() });
  if (includeFrontend) {
    writeEvidenceFile(dir, 'screenshots.json', { paths: ['/workspace/output/screenshots/login.png'] });
  }
}

const backendExecFn = async () => ({ stdout: 'src/auth/login.ts\nsrc/api/users.ts\n' });
const frontendExecFn = async () => ({ stdout: 'src/views/Login.tsx\nsrc/styles/main.css\n' });
const failingExecFn = async () => { throw new Error('git not available'); };

// --- Tests ---

describe('isFrontendChange', () => {
  // Test 1
  it('returns true for files containing .tsx extension', () => {
    expect(isFrontendChange(['src/views/Login.tsx', 'src/api/users.ts'])).toBe(true);
  });

  // Test 2
  it('returns true for .jsx, .css, .html extensions', () => {
    expect(isFrontendChange(['src/views/Component.jsx'])).toBe(true);
    expect(isFrontendChange(['src/styles/main.css'])).toBe(true);
    expect(isFrontendChange(['public/index.html'])).toBe(true);
  });

  // Test 3
  it('returns false for .ts, .js, .json, .md files only', () => {
    expect(isFrontendChange(['src/auth/login.ts', 'src/api/users.js', 'package.json', 'README.md'])).toBe(false);
  });
});

describe('getRequiredEvidenceFiles', () => {
  // Test 4
  it('returns 3 files (no screenshots) when isFrontend=false', () => {
    const files = getRequiredEvidenceFiles(false);
    expect(files).toHaveLength(3);
    expect(files).toContain('test-logs.json');
    expect(files).toContain('coverage-delta.json');
    expect(files).toContain('verification-notes.json');
    expect(files).not.toContain('screenshots.json');
  });

  // Test 5
  it('returns 4 files (with screenshots) when isFrontend=true', () => {
    const files = getRequiredEvidenceFiles(true);
    expect(files).toHaveLength(4);
    expect(files).toContain('test-logs.json');
    expect(files).toContain('coverage-delta.json');
    expect(files).toContain('verification-notes.json');
    expect(files).toContain('screenshots.json');
  });
});

describe('checkQaEvidence', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-evidence-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 6
  it('returns { complete: true } when all required files exist', () => {
    writeAllRequiredFiles(tmpDir, false);
    const result = checkQaEvidence(tmpDir, false);
    expect(result.complete).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  // Test 7
  it('returns { complete: false, missing: [...] } when test-logs.json missing', () => {
    writeEvidenceFile(tmpDir, 'coverage-delta.json', {});
    writeEvidenceFile(tmpDir, 'verification-notes.json', {});
    const result = checkQaEvidence(tmpDir, false);
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('test-logs.json');
  });

  // Test 8
  it('returns { complete: false, missing: [screenshots.json] } for frontend change without screenshots', () => {
    writeAllRequiredFiles(tmpDir, false);  // write 3 files but NOT screenshots.json
    const result = checkQaEvidence(tmpDir, true);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['screenshots.json']);
  });

  // Test 9
  it('returns { complete: true } for backend-only change without screenshots', () => {
    writeAllRequiredFiles(tmpDir, false);  // write 3 required files, no screenshots.json
    const result = checkQaEvidence(tmpDir, false);
    expect(result.complete).toBe(true);
    expect(result.missing).toHaveLength(0);
  });
});

describe('createQaEvidenceGateHook', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-gate-hook-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Test 10
  it('returns {} (allow) when isMain=true (dispatch exempt)', async () => {
    const hook = createQaEvidenceGateHook(true, tmpDir, backendExecFn);
    const input = makePreToolUseInput('Bash', 'gh pr review 42 --approve');

    const result = await hook(input);
    expect(result).toEqual({});
  });

  // Test 11
  it('returns {} when command does not contain gh pr review', async () => {
    const hook = createQaEvidenceGateHook(false, tmpDir, backendExecFn);
    const input = makePreToolUseInput('Bash', 'git commit -m "fix bug"');

    const result = await hook(input);
    expect(result).toEqual({});
  });

  // Test 12
  it('returns deny when command contains gh pr review --approve and evidence incomplete', async () => {
    const hook = createQaEvidenceGateHook(false, tmpDir, backendExecFn);
    const input = makePreToolUseInput('Bash', 'gh pr review 42 --approve --body "LGTM"');

    const result = await hook(input);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('test-logs.json');
    expect(result.systemMessage).toContain('qa-evidence');
  });

  // Test 13
  it('returns {} when all evidence files present', async () => {
    writeAllRequiredFiles(tmpDir, false);
    const hook = createQaEvidenceGateHook(false, tmpDir, backendExecFn);
    const input = makePreToolUseInput('Bash', 'gh pr review 42 --approve');

    const result = await hook(input);
    expect(result).toEqual({});
  });

  // Test 14
  it('only triggers on --approve (not --request-changes or --comment)', async () => {
    const hook = createQaEvidenceGateHook(false, tmpDir, backendExecFn);

    const requestChanges = makePreToolUseInput('Bash', 'gh pr review 42 --request-changes --body "needs work"');
    expect(await hook(requestChanges)).toEqual({});

    const comment = makePreToolUseInput('Bash', 'gh pr review 42 --comment --body "looks interesting"');
    expect(await hook(comment)).toEqual({});
  });

  it('requires screenshots when frontend files changed', async () => {
    // Write backend-only evidence (no screenshots.json)
    writeAllRequiredFiles(tmpDir, false);
    const hook = createQaEvidenceGateHook(false, tmpDir, frontendExecFn);
    const input = makePreToolUseInput('Bash', 'gh pr review 42 --approve');

    const result = await hook(input);
    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('screenshots.json');
  });

  it('allows approval when all evidence including screenshots present for frontend change', async () => {
    writeAllRequiredFiles(tmpDir, true);  // include screenshots.json
    const hook = createQaEvidenceGateHook(false, tmpDir, frontendExecFn);
    const input = makePreToolUseInput('Bash', 'gh pr review 42 --approve');

    const result = await hook(input);
    expect(result).toEqual({});
  });

  it('defaults to non-frontend (no screenshot requirement) when git diff fails', async () => {
    writeAllRequiredFiles(tmpDir, false);  // 3 required files, no screenshots
    const hook = createQaEvidenceGateHook(false, tmpDir, failingExecFn);
    const input = makePreToolUseInput('Bash', 'gh pr review 42 --approve');

    // Should allow because git diff failed and we default to non-frontend
    const result = await hook(input);
    expect(result).toEqual({});
  });

  it('returns {} when hook_event_name is not PreToolUse', async () => {
    const hook = createQaEvidenceGateHook(false, tmpDir, backendExecFn);
    const input = {
      hook_event_name: 'PreCompact',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr review 42 --approve' },
    };

    const result = await hook(input);
    expect(result).toEqual({});
  });

  it('returns {} when tool_name is not Bash', async () => {
    const hook = createQaEvidenceGateHook(false, tmpDir, backendExecFn);
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { command: 'gh pr review 42 --approve' },
    };

    const result = await hook(input);
    expect(result).toEqual({});
  });
});
