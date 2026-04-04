/**
 * Tests for drainIpcInput() groupFolder filtering logic.
 *
 * The actual drainIpcInput() is inside container/agent-runner/src/index.ts
 * and reads from the filesystem. This test replicates the core filtering
 * logic to verify that IPC messages are correctly filtered by groupFolder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Extracted filtering logic from drainIpcInput() in index.ts (lines 279-307).
 * Takes an IPC input directory and the current group folder, returns consumed messages.
 */
function drainIpcInput(ipcInputDir, myGroupFolder) {
  fs.mkdirSync(ipcInputDir, { recursive: true });
  const files = fs.readdirSync(ipcInputDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  const messages = [];
  for (const file of files) {
    const filePath = path.join(ipcInputDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      // Only consume messages intended for this container's group
      if (data.groupFolder && data.groupFolder !== myGroupFolder) continue;
      fs.unlinkSync(filePath);
      if (data.type === 'message' && data.text) {
        messages.push(data.text);
      }
    } catch {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  }
  return messages;
}

describe('drainIpcInput groupFolder filtering', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('consumes messages matching the current groupFolder', () => {
    fs.writeFileSync(
      path.join(tmpDir, '001.json'),
      JSON.stringify({ type: 'message', text: 'hello from dispatch', groupFolder: 'slack_qa-sentinel' }),
    );

    const messages = drainIpcInput(tmpDir, 'slack_qa-sentinel');

    expect(messages).toEqual(['hello from dispatch']);
    // File should be consumed (deleted)
    expect(fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'))).toHaveLength(0);
  });

  it('skips messages for a different groupFolder without deleting them', () => {
    fs.writeFileSync(
      path.join(tmpDir, '001.json'),
      JSON.stringify({ type: 'message', text: 'for dev-team only', groupFolder: 'slack_dev-team' }),
    );

    const messages = drainIpcInput(tmpDir, 'slack_qa-sentinel');

    expect(messages).toEqual([]);
    // File should NOT be consumed — still present for the correct group
    expect(fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'))).toHaveLength(1);
  });

  it('consumes messages without a groupFolder field (backwards compatible)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '001.json'),
      JSON.stringify({ type: 'message', text: 'legacy message' }),
    );

    const messages = drainIpcInput(tmpDir, 'slack_qa-sentinel');

    expect(messages).toEqual(['legacy message']);
    expect(fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'))).toHaveLength(0);
  });

  it('filters correctly when multiple messages are present', () => {
    fs.writeFileSync(
      path.join(tmpDir, '001.json'),
      JSON.stringify({ type: 'message', text: 'for me', groupFolder: 'slack_dispatch' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, '002.json'),
      JSON.stringify({ type: 'message', text: 'not for me', groupFolder: 'slack_dev-team' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, '003.json'),
      JSON.stringify({ type: 'message', text: 'also for me', groupFolder: 'slack_dispatch' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, '004.json'),
      JSON.stringify({ type: 'message', text: 'no group field' }),
    );

    const messages = drainIpcInput(tmpDir, 'slack_dispatch');

    expect(messages).toEqual(['for me', 'also for me', 'no group field']);
    // Only the non-matching file should remain
    const remaining = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
    expect(remaining).toEqual(['002.json']);
  });

  it('handles malformed JSON by deleting the file', () => {
    fs.writeFileSync(path.join(tmpDir, '001.json'), 'not valid json{{{');

    const messages = drainIpcInput(tmpDir, 'slack_dispatch');

    expect(messages).toEqual([]);
    expect(fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'))).toHaveLength(0);
  });

  it('ignores non-message types even when groupFolder matches', () => {
    fs.writeFileSync(
      path.join(tmpDir, '001.json'),
      JSON.stringify({ type: 'task', data: { id: '123' }, groupFolder: 'slack_dispatch' }),
    );

    const messages = drainIpcInput(tmpDir, 'slack_dispatch');

    expect(messages).toEqual([]);
    // File is consumed (deleted) but produces no message text
    expect(fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'))).toHaveLength(0);
  });
});
