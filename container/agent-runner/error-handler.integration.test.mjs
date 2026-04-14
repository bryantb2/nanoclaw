/**
 * Integration tests for the error handler IPC file writing logic.
 *
 * Tests that rate_limit and auth errors produce TWO IPC files:
 *   1. Friendly main channel message
 *   2. Raw debug thread reply
 * Budget errors produce one file. Other errors produce none.
 *
 * Uses real filesystem with temp directories.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// --- Replicated classifyApiError (from index.ts lines 243-254) ---

function classifyApiError(message) {
  const isRateLimitError = /rate.?limit|too many requests|429/i.test(message);
  if (isRateLimitError) return 'rate_limit';

  const isAuthError = /authentication_error|invalid.?api.?key|401\b/i.test(message);
  if (isAuthError) return 'auth';

  const isBudgetError = /budget|credit|billing|payment|quota|limit exceeded|overloaded|529|402/i.test(message);
  if (isBudgetError) return 'budget';

  return 'other';
}

/**
 * Replicated error handler IPC write logic (from index.ts lines 776-844).
 * Uses configurable messagesDir instead of hardcoded /workspace/ipc/messages.
 */
function handleErrorIpc(errorMessage, containerInput, messagesDir) {
  const errorType = classifyApiError(errorMessage);
  const filesWritten = [];

  if (errorType === 'rate_limit' || errorType === 'auth') {
    fs.mkdirSync(messagesDir, { recursive: true });

    const friendlyText = errorType === 'rate_limit'
      ? 'Fleet is at capacity — try again in a few minutes.'
      : 'Fleet API key error — check Infisical credentials.';

    // Main channel message (friendly)
    const mainFilename = `${Date.now()}-${errorType}-friendly.json`;
    const mainPayload = {
      type: 'message',
      chatJid: containerInput.chatJid,
      text: friendlyText,
      groupFolder: containerInput.groupFolder,
      timestamp: new Date().toISOString(),
    };
    const mainTmp = path.join(messagesDir, `${mainFilename}.tmp`);
    fs.writeFileSync(mainTmp, JSON.stringify(mainPayload, null, 2));
    fs.renameSync(mainTmp, path.join(messagesDir, mainFilename));
    filesWritten.push(mainFilename);

    // Thread reply with raw error for debugging
    if (containerInput.threadTs) {
      const debugFilename = `${Date.now()}-${errorType}-debug.json`;
      const debugPayload = {
        type: 'message',
        chatJid: containerInput.chatJid,
        text: `Debug: ${errorMessage}`,
        threadTs: containerInput.threadTs,
        groupFolder: containerInput.groupFolder,
        timestamp: new Date().toISOString(),
      };
      const debugTmp = path.join(messagesDir, `${debugFilename}.tmp`);
      fs.writeFileSync(debugTmp, JSON.stringify(debugPayload, null, 2));
      fs.renameSync(debugTmp, path.join(messagesDir, debugFilename));
      filesWritten.push(debugFilename);
    }
  } else if (errorType === 'budget') {
    fs.mkdirSync(messagesDir, { recursive: true });

    const filename = `${Date.now()}-budget-exhausted.json`;
    const payload = {
      type: 'message',
      chatJid: containerInput.chatJid,
      text: `Budget exhausted — cannot process this task. Task: ${containerInput.prompt.slice(0, 120)}${containerInput.prompt.length > 120 ? '...' : ''}. Retry after limit resets.`,
      groupFolder: containerInput.groupFolder,
      timestamp: new Date().toISOString(),
    };
    const tmp = path.join(messagesDir, `${filename}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, path.join(messagesDir, filename));
    filesWritten.push(filename);
  }

  return { errorType, filesWritten };
}

// --- Tests ---

describe('error handler IPC file writing', () => {
  let tmpDir;
  let messagesDir;
  const baseInput = {
    chatJid: 'C123456',
    groupFolder: 'slack_dev-team',
    threadTs: '1234567890.123456',
    prompt: 'Fix the login bug in auth middleware',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-handler-test-'));
    messagesDir = path.join(tmpDir, 'messages');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('rate limit errors', () => {
    it('writes friendly message + debug thread reply for rate limit', () => {
      const { errorType, filesWritten } = handleErrorIpc(
        'Rate limit exceeded', baseInput, messagesDir
      );

      expect(errorType).toBe('rate_limit');
      expect(filesWritten).toHaveLength(2);

      const files = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
      expect(files).toHaveLength(2);

      // Check friendly message
      const friendlyFile = files.find(f => f.includes('friendly'));
      const friendly = JSON.parse(fs.readFileSync(path.join(messagesDir, friendlyFile), 'utf-8'));
      expect(friendly.text).toBe('Fleet is at capacity — try again in a few minutes.');
      expect(friendly.chatJid).toBe('C123456');
      expect(friendly.type).toBe('message');
      expect(friendly.threadTs).toBeUndefined(); // main channel, not threaded

      // Check debug thread reply
      const debugFile = files.find(f => f.includes('debug'));
      const debug = JSON.parse(fs.readFileSync(path.join(messagesDir, debugFile), 'utf-8'));
      expect(debug.text).toBe('Debug: Rate limit exceeded');
      expect(debug.threadTs).toBe('1234567890.123456');
      expect(debug.chatJid).toBe('C123456');
    });

    it('writes only friendly message when no threadTs', () => {
      const inputNoThread = { ...baseInput, threadTs: undefined };
      const { filesWritten } = handleErrorIpc(
        '429 Too Many Requests', inputNoThread, messagesDir
      );

      expect(filesWritten).toHaveLength(1);
      const files = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
      expect(files).toHaveLength(1);

      const friendly = JSON.parse(fs.readFileSync(path.join(messagesDir, files[0]), 'utf-8'));
      expect(friendly.text).toBe('Fleet is at capacity — try again in a few minutes.');
    });
  });

  describe('auth errors', () => {
    it('writes friendly message + debug thread reply for auth error', () => {
      const { errorType, filesWritten } = handleErrorIpc(
        'authentication_error: invalid api key', baseInput, messagesDir
      );

      expect(errorType).toBe('auth');
      expect(filesWritten).toHaveLength(2);

      const files = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
      const friendlyFile = files.find(f => f.includes('friendly'));
      const friendly = JSON.parse(fs.readFileSync(path.join(messagesDir, friendlyFile), 'utf-8'));
      expect(friendly.text).toBe('Fleet API key error — check Infisical credentials.');
    });

    it('handles 401 Unauthorized', () => {
      const { errorType } = handleErrorIpc(
        '401 Unauthorized', baseInput, messagesDir
      );
      expect(errorType).toBe('auth');

      const files = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
      expect(files).toHaveLength(2);
    });
  });

  describe('budget errors', () => {
    it('writes single budget exhaustion message', () => {
      const { errorType, filesWritten } = handleErrorIpc(
        'error_max_budget_usd: budget exceeded', baseInput, messagesDir
      );

      expect(errorType).toBe('budget');
      expect(filesWritten).toHaveLength(1);

      const files = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
      expect(files).toHaveLength(1);

      const budget = JSON.parse(fs.readFileSync(path.join(messagesDir, files[0]), 'utf-8'));
      expect(budget.text).toContain('Budget exhausted');
      expect(budget.text).toContain('Fix the login bug');
    });

    it('truncates long prompts in budget message', () => {
      const longPrompt = 'x'.repeat(200);
      const inputLong = { ...baseInput, prompt: longPrompt };
      const { filesWritten } = handleErrorIpc(
        'budget exceeded', inputLong, messagesDir
      );

      expect(filesWritten).toHaveLength(1);
      const files = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
      const budget = JSON.parse(fs.readFileSync(path.join(messagesDir, files[0]), 'utf-8'));
      expect(budget.text).toContain('...');
      // Should include first 120 chars of prompt
      expect(budget.text).toContain('x'.repeat(120));
    });
  });

  describe('other errors (no IPC files)', () => {
    it('writes no files for generic errors', () => {
      const { errorType, filesWritten } = handleErrorIpc(
        'Internal server error', baseInput, messagesDir
      );

      expect(errorType).toBe('other');
      expect(filesWritten).toHaveLength(0);
      expect(fs.existsSync(messagesDir)).toBe(false);
    });

    it('writes no files for JSON parse errors', () => {
      const { errorType, filesWritten } = handleErrorIpc(
        'unexpected token in JSON at position 42', baseInput, messagesDir
      );

      expect(errorType).toBe('other');
      expect(filesWritten).toHaveLength(0);
    });
  });

  describe('atomic writes (.tmp → rename)', () => {
    it('no .tmp files remain after writing', () => {
      handleErrorIpc('Rate limit exceeded', baseInput, messagesDir);

      const allFiles = fs.readdirSync(messagesDir);
      const tmpFiles = allFiles.filter(f => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('classification ordering', () => {
    it('credit limit exceeded → budget (NOT rate_limit)', () => {
      const { errorType } = handleErrorIpc(
        'credit limit exceeded', baseInput, messagesDir
      );
      expect(errorType).toBe('budget');
    });

    it('rate limit exceeded → rate_limit (checked before budget)', () => {
      const { errorType } = handleErrorIpc(
        'rate limit exceeded', baseInput, messagesDir
      );
      expect(errorType).toBe('rate_limit');
    });
  });
});
