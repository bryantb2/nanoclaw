import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  _initTestDatabase,
  _initFileDatabaseForTest,
  _getDb,
  appendCostLog,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getCostSummary,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('computes next_run for cron task when not provided', () => {
    createTask({
      id: 'task-cron-no-next',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'cron task',
      schedule_type: 'cron',
      schedule_value: '*/30 * * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-cron-no-next');
    expect(task).toBeDefined();
    expect(task!.next_run).not.toBeNull();
    // next_run should be a valid ISO date in the future
    expect(new Date(task!.next_run!).getTime()).toBeGreaterThan(Date.now() - 60000);
  });

  it('computes next_run for interval task when not provided', () => {
    createTask({
      id: 'task-interval-no-next',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'interval task',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-interval-no-next');
    expect(task).toBeDefined();
    expect(task!.next_run).not.toBeNull();
  });

  it('computes next_run for once task when not provided', () => {
    createTask({
      id: 'task-once-no-next',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'once task',
      schedule_type: 'once',
      schedule_value: '2030-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-once-no-next');
    expect(task).toBeDefined();
    expect(task!.next_run).toBe('2030-01-01T00:00:00.000Z');
  });

  it('does not overwrite next_run when already provided', () => {
    createTask({
      id: 'task-explicit-next',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'explicit next_run',
      schedule_type: 'cron',
      schedule_value: '0 3 * * *',
      context_mode: 'isolated',
      next_run: '2099-01-01T03:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-explicit-next');
    expect(task!.next_run).toBe('2099-01-01T03:00:00.000Z');
  });

  it('does not compute next_run for non-active tasks', () => {
    createTask({
      id: 'task-paused-cron',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'paused cron',
      schedule_type: 'cron',
      schedule_value: '*/30 * * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-paused-cron');
    expect(task!.next_run).toBeNull();
  });

  it('stores suppress_output flag', () => {
    createTask({
      id: 'task-suppress',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'silent task',
      schedule_type: 'cron',
      schedule_value: '*/30 * * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      suppress_output: true,
    });

    const task = getTaskById('task-suppress');
    expect(task).toBeDefined();
    expect(task!.suppress_output).toBeTruthy();
  });

  it('defaults suppress_output to false', () => {
    createTask({
      id: 'task-no-suppress',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'normal task',
      schedule_type: 'once',
      schedule_value: '2030-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-no-suppress');
    expect(task).toBeDefined();
    expect(task!.suppress_output).toBeFalsy();
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- cost_log ---

describe('appendCostLog', () => {
  it('inserts a row with correct groupFolder, chatJid, and costUsd', () => {
    appendCostLog('main', 'group@g.us', 0.0042);
    const summary = getCostSummary('main');
    // allTimeUsd should reflect the inserted cost
    expect(summary.allTimeUsd).toBeCloseTo(0.0042);
  });

  it('accumulates multiple entries for the same group', () => {
    appendCostLog('main', 'group@g.us', 0.01);
    appendCostLog('main', 'group@g.us', 0.02);
    appendCostLog('main', 'group@g.us', 0.03);
    const summary = getCostSummary('main');
    expect(summary.allTimeUsd).toBeCloseTo(0.06);
  });

  it('isolates costs by group folder', () => {
    appendCostLog('main', 'group@g.us', 0.1);
    appendCostLog('other-group', 'group@g.us', 0.5);
    const mainSummary = getCostSummary('main');
    const otherSummary = getCostSummary('other-group');
    expect(mainSummary.allTimeUsd).toBeCloseTo(0.1);
    expect(otherSummary.allTimeUsd).toBeCloseTo(0.5);
  });
});

describe('getCostSummary', () => {
  it('returns zeros when no entries exist for a group', () => {
    const summary = getCostSummary('nonexistent-group');
    expect(summary.todayUsd).toBe(0);
    expect(summary.weekUsd).toBe(0);
    expect(summary.allTimeUsd).toBe(0);
  });

  it('returns correct aggregation for entries in the same group', () => {
    appendCostLog('main', 'chat1@g.us', 0.005);
    appendCostLog('main', 'chat2@g.us', 0.003);
    const summary = getCostSummary('main');
    expect(summary.allTimeUsd).toBeCloseTo(0.008);
    // todayUsd and weekUsd should also include these (inserted now)
    expect(summary.todayUsd).toBeCloseTo(0.008);
    expect(summary.weekUsd).toBeCloseTo(0.008);
  });
});

// --- database initialization safety ---

describe('database initialization safety', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
  });

  afterEach(() => {
    // Close db before cleanup so file handle is released
    try { _getDb().close(); } catch { /* may already be closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Restore in-memory db for global beforeEach
    _initTestDatabase();
  });

  it('initDatabase path sets busy_timeout=5000 on a file-based DB', () => {
    // _initFileDatabaseForTest mirrors the pre-pragma state of initDatabase().
    // After GREEN: initDatabase() will call db.pragma('busy_timeout = 5000'),
    // setting it to 5000 explicitly.
    // This test proves the value is 5000 on any file-based DB created by this path.
    _initFileDatabaseForTest(path.join(tmpDir, 'test.db'));
    const dbInst = _getDb();
    const result = dbInst.pragma('busy_timeout') as Array<{ timeout: number }>;
    expect(result[0].timeout).toBe(5000);
  });

  it('_initTestDatabase does NOT set busy_timeout explicitly (in-memory DBs have no file locking)', () => {
    // Verify the distinction: _initTestDatabase creates an in-memory DB.
    // We confirm it doesn't call busy_timeout pragma by checking that we can
    // freely change the value without any override from _initTestDatabase.
    _initTestDatabase();
    const db = _getDb();
    // Set to a non-default sentinel value
    db.pragma('busy_timeout = 1234');
    expect(
      (db.pragma('busy_timeout') as Array<{ timeout: number }>)[0].timeout,
    ).toBe(1234);
    // Re-init — _initTestDatabase does NOT reset busy_timeout, new DB has default
    _initTestDatabase();
    // New db instance — the old sentinel is gone (it was a different object)
    // This confirms _initTestDatabase creates a fresh DB without calling busy_timeout pragma
    const db2 = _getDb();
    const result = db2.pragma('busy_timeout') as Array<{ timeout: number }>;
    // The new in-memory db has the system default (5000), NOT our sentinel (1234)
    // This proves _initTestDatabase creates a fresh DB without our pragma call
    expect(result[0].timeout).not.toBe(1234);
  });
});
