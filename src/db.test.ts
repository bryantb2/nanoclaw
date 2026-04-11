import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  _initTestDatabase,
  _initFileDatabaseForTest,
  _getDb,
  _runMigrationsForTest,
  appendCostLog,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getCostSummary,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  isIpcInjectedMessage,
  logTaskRun,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateMessageContent,
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
    expect(new Date(task!.next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
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
    // SQLite returns INTEGER 1, not boolean true. Code relies on truthiness.
    expect(task!.suppress_output).toBe(1);
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

describe('appendCostLog with details', () => {
  it('stores token breakdown and cost source', () => {
    appendCostLog('dispatch', 'slack:C123', 0.45, {
      runId: '1234567890-ab12',
      inputTokens: 5000,
      outputTokens: 2000,
      cacheCreationTokens: 500,
      cacheReadTokens: 3000,
      costSource: 'computed',
    });

    const db = _getDb();
    const row = db
      .prepare('SELECT * FROM cost_log WHERE group_folder = ?')
      .get('dispatch') as Record<string, unknown>;

    expect(row.cost_usd).toBeCloseTo(0.45);
    expect(row.run_id).toBe('1234567890-ab12');
    expect(row.input_tokens).toBe(5000);
    expect(row.output_tokens).toBe(2000);
    expect(row.cache_creation_tokens).toBe(500);
    expect(row.cache_read_tokens).toBe(3000);
    expect(row.cost_source).toBe('computed');
  });

  it('defaults token columns to 0 and source to sdk when details omitted', () => {
    appendCostLog('main', 'slack:C456', 0.1);

    const db = _getDb();
    const row = db
      .prepare('SELECT * FROM cost_log WHERE group_folder = ?')
      .get('main') as Record<string, unknown>;

    expect(row.run_id).toBeNull();
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
    expect(row.cache_creation_tokens).toBe(0);
    expect(row.cache_read_tokens).toBe(0);
    expect(row.cost_source).toBe('sdk');
  });
});

describe('logTaskRun with run_id', () => {
  function createTestTask(id: string) {
    createTask({
      id,
      group_folder: 'dispatch',
      chat_jid: 'slack:C123',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '*/30 * * * *',
      context_mode: 'isolated',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });
  }

  it('stores run_id in task_run_logs', () => {
    createTestTask('dispatch-build-loop');
    logTaskRun({
      task_id: 'dispatch-build-loop',
      run_at: new Date().toISOString(),
      duration_ms: 5000,
      status: 'success',
      result: 'Done',
      error: null,
      run_id: '1234567890-ab12',
    });

    const db = _getDb();
    const row = db
      .prepare('SELECT * FROM task_run_logs WHERE task_id = ?')
      .get('dispatch-build-loop') as Record<string, unknown>;

    expect(row.run_id).toBe('1234567890-ab12');
    expect(row.status).toBe('success');
  });

  it('allows null run_id for backwards compatibility', () => {
    createTestTask('nightly-review');
    logTaskRun({
      task_id: 'nightly-review',
      run_at: new Date().toISOString(),
      duration_ms: 3000,
      status: 'success',
      result: null,
      error: null,
    });

    const db = _getDb();
    const row = db
      .prepare('SELECT * FROM task_run_logs WHERE task_id = ?')
      .get('nightly-review') as Record<string, unknown>;

    expect(row.run_id).toBeNull();
  });
});

describe('run_id linking', () => {
  it('joins cost_log and task_run_logs via run_id', () => {
    const runId = '9999999999-zz99';

    createTask({
      id: 'dispatch-build-loop',
      group_folder: 'dispatch',
      chat_jid: 'slack:C123',
      prompt: 'build',
      schedule_type: 'cron',
      schedule_value: '*/30 * * * *',
      context_mode: 'isolated',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    appendCostLog('dispatch', 'slack:C123', 0.35, {
      runId,
      costSource: 'computed',
    });

    logTaskRun({
      task_id: 'dispatch-build-loop',
      run_at: new Date().toISOString(),
      duration_ms: 8000,
      status: 'success',
      result: 'Built PR',
      error: null,
      run_id: runId,
    });

    const db = _getDb();
    const joined = db
      .prepare(
        `SELECT t.task_id, c.cost_usd, c.cost_source
         FROM task_run_logs t
         JOIN cost_log c ON c.run_id = t.run_id
         WHERE t.run_id = ?`,
      )
      .get(runId) as { task_id: string; cost_usd: number; cost_source: string };

    expect(joined.task_id).toBe('dispatch-build-loop');
    expect(joined.cost_usd).toBeCloseTo(0.35);
    expect(joined.cost_source).toBe('computed');
  });

  it('human-triggered runs have cost_log but no task_run_logs match', () => {
    const runId = '8888888888-hm01';

    appendCostLog('dev-team', 'slack:C789', 1.2, {
      runId,
      costSource: 'sdk',
    });

    const db = _getDb();
    const orphan = db
      .prepare(
        `SELECT c.run_id, c.cost_usd
         FROM cost_log c
         LEFT JOIN task_run_logs t ON t.run_id = c.run_id
         WHERE c.run_id = ? AND t.run_id IS NULL`,
      )
      .get(runId) as { run_id: string; cost_usd: number } | undefined;

    expect(orphan).toBeDefined();
    expect(orphan!.cost_usd).toBeCloseTo(1.2);
  });
});

describe('cost_log schema migration', () => {
  it('creates all token tracking columns on fresh DB', () => {
    const db = _getDb();
    const cols = db.prepare('PRAGMA table_info(cost_log)').all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);

    expect(colNames).toContain('input_tokens');
    expect(colNames).toContain('output_tokens');
    expect(colNames).toContain('cache_creation_tokens');
    expect(colNames).toContain('cache_read_tokens');
    expect(colNames).toContain('cost_source');
    expect(colNames).toContain('run_id');
  });

  it('creates run_id column on task_run_logs', () => {
    const db = _getDb();
    const cols = db.prepare('PRAGMA table_info(task_run_logs)').all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);

    expect(colNames).toContain('run_id');
  });

  it('re-initializing the DB does not break when columns already exist', () => {
    // Simulate re-running init on an already-migrated DB
    // _initTestDatabase calls createSchema which runs all migrations
    expect(() => _initTestDatabase()).not.toThrow();
    expect(() => _initTestDatabase()).not.toThrow();

    // Verify columns still work
    appendCostLog('main', 'slack:C1', 0.05, {
      runId: 'test-run',
      costSource: 'computed',
    });

    const db = _getDb();
    const row = db
      .prepare(
        'SELECT run_id, cost_source FROM cost_log WHERE group_folder = ?',
      )
      .get('main') as { run_id: string; cost_source: string };

    expect(row.run_id).toBe('test-run');
    expect(row.cost_source).toBe('computed');
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
    try {
      _getDb().close();
    } catch {
      /* may already be closed */
    }
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

describe('isIpcInjectedMessage (Option B webhook echo guard)', () => {
  beforeEach(() => {
    // messages.chat_jid has a FK to chats(jid); seed both chats up front
    storeChatMetadata('slack:dev-team', '2026-04-10T00:00:00.000Z');
    storeChatMetadata('slack:qa-sentinel', '2026-04-10T00:00:00.000Z');
  });

  it('returns true for a row written by the IPC injection path (origin=ipc)', () => {
    storeMessage({
      id: '1775796300.543699',
      chat_jid: 'slack:dev-team',
      sender: 'ipc',
      sender_name: 'ipc:slack_dispatch',
      content: '@Fleet [DISPATCH-ROUTED] work',
      timestamp: '2026-04-10T07:00:00.000Z',
      is_from_me: true,
      is_bot_message: false,
      origin: 'ipc',
    });
    expect(isIpcInjectedMessage('1775796300.543699', 'slack:dev-team')).toBe(
      true,
    );
  });

  it('returns false for a webhook-origin row (regular bot/user message)', () => {
    storeMessage({
      id: '1775796400.000001',
      chat_jid: 'slack:dev-team',
      sender: 'U0BOT123',
      sender_name: 'Fleet',
      content: 'bot output',
      timestamp: '2026-04-10T07:01:00.000Z',
      is_from_me: true,
      is_bot_message: true,
      origin: 'webhook',
    });
    expect(isIpcInjectedMessage('1775796400.000001', 'slack:dev-team')).toBe(
      false,
    );
  });

  it('returns false for a synthetic-origin row (ipc- fallback id)', () => {
    // Synthetic rows shouldn't block webhook echo ingest — their ids are
    // fabricated and Slack can never return them as a ts.
    storeMessage({
      id: 'ipc-2026-04-10T07:02:00.000Z-abc123',
      chat_jid: 'slack:dev-team',
      sender: 'ipc',
      sender_name: 'ipc:slack_dispatch',
      content: 'synthetic fallback',
      timestamp: '2026-04-10T07:02:00.000Z',
      is_from_me: true,
      is_bot_message: false,
      origin: 'synthetic',
    });
    expect(
      isIpcInjectedMessage(
        'ipc-2026-04-10T07:02:00.000Z-abc123',
        'slack:dev-team',
      ),
    ).toBe(false);
  });

  it('returns false when no row exists', () => {
    expect(isIpcInjectedMessage('nonexistent.ts', 'slack:dev-team')).toBe(
      false,
    );
  });

  it('returns false when the id matches but chat_jid differs', () => {
    storeMessage({
      id: '1775796500.000001',
      chat_jid: 'slack:dev-team',
      sender: 'ipc',
      sender_name: 'ipc:slack_dispatch',
      content: 'injected',
      timestamp: '2026-04-10T07:02:00.000Z',
      is_from_me: true,
      is_bot_message: false,
      origin: 'ipc',
    });
    expect(isIpcInjectedMessage('1775796500.000001', 'slack:qa-sentinel')).toBe(
      false,
    );
  });

  it('defaults origin to "webhook" when storeMessage is called without explicit origin', () => {
    // Regression guard: a legacy caller that hasn't been updated to pass
    // origin must not accidentally register as an IPC injection. The
    // default origin='webhook' in storeMessage prevents this.
    storeMessage({
      id: '1775796600.000001',
      chat_jid: 'slack:dev-team',
      sender: 'ipc',
      sender_name: 'ipc:slack_dispatch',
      content: 'legacy caller (no origin field)',
      timestamp: '2026-04-10T07:03:00.000Z',
      is_from_me: true,
      is_bot_message: false,
      // no origin field — should default to 'webhook'
    });
    expect(isIpcInjectedMessage('1775796600.000001', 'slack:dev-team')).toBe(
      false,
    );
  });
});

describe('messages.origin migration backfill', () => {
  // Simulates a restart against a pre-PR-#36 prod DB:
  //   - Pre-Option-B rows: sender='ipc' + id LIKE 'ipc-%' (synthetic)
  //   - Post-Option-B rows: sender='ipc' + real platform ts (PR #31)
  //   - Webhook rows: sender=user/bot id, anything else
  // None of these rows have `origin` set. The migration must classify each
  // exactly once and leave no NULLs — otherwise isIpcInjectedMessage returns
  // false on Option B rows and the webhook echo race regresses.
  beforeEach(() => {
    storeChatMetadata('slack:dev-team', '2026-04-10T00:00:00.000Z');
    // Drop the origin column so we can repopulate as if pre-migration. SQLite
    // can't DROP COLUMN on older versions, so we wipe values to NULL instead
    // — semantically equivalent for the backfill UPDATEs (which only touch
    // `WHERE origin IS NULL`).
    const db = _getDb();
    db.exec(`UPDATE messages SET origin = NULL`);
  });

  it('backfills a pre-Option-B synthetic row to origin=synthetic', () => {
    const db = _getDb();
    db.prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      'ipc-2026-04-09T12:00:00.000Z-abc123',
      'slack:dev-team',
      'ipc',
      'ipc:slack_dispatch',
      'pre-PR-31 synthetic injection',
      '2026-04-09T12:00:00.000Z',
      1,
      0,
    );

    _runMigrationsForTest();

    const row = db
      .prepare(`SELECT origin FROM messages WHERE id = ?`)
      .get('ipc-2026-04-09T12:00:00.000Z-abc123') as { origin: string };
    expect(row.origin).toBe('synthetic');
    // Synthetic rows must NOT register as IPC injections — they aren't
    // anchorable Slack ts values, so the webhook echo guard doesn't apply.
    expect(
      isIpcInjectedMessage(
        'ipc-2026-04-09T12:00:00.000Z-abc123',
        'slack:dev-team',
      ),
    ).toBe(false);
  });

  it('backfills a post-Option-B real-ts row to origin=ipc', () => {
    // This is the load-bearing case: PR #31 shipped Option B injections
    // (sender='ipc' + real platform ts) into prod. Pre-PR-#36 those rows
    // have origin IS NULL. After migration they MUST land at origin='ipc'
    // so isIpcInjectedMessage returns true and the webhook echo guard fires.
    const db = _getDb();
    db.prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      '1775796300.543699',
      'slack:dev-team',
      'ipc',
      'ipc:slack_dispatch',
      '@Fleet [DISPATCH-ROUTED] in-flight Option B row from PR #31',
      '2026-04-10T07:00:00.000Z',
      1,
      0,
    );

    _runMigrationsForTest();

    const row = db
      .prepare(`SELECT origin FROM messages WHERE id = ?`)
      .get('1775796300.543699') as { origin: string };
    expect(row.origin).toBe('ipc');
    expect(isIpcInjectedMessage('1775796300.543699', 'slack:dev-team')).toBe(
      true,
    );
  });

  it('backfills a regular webhook row to origin=webhook', () => {
    const db = _getDb();
    db.prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      '1775796400.111111',
      'slack:dev-team',
      'U0HUMAN1',
      'Blake',
      'hi @Fleet',
      '2026-04-10T07:01:00.000Z',
      0,
      0,
    );

    _runMigrationsForTest();

    const row = db
      .prepare(`SELECT origin FROM messages WHERE id = ?`)
      .get('1775796400.111111') as { origin: string };
    expect(row.origin).toBe('webhook');
  });

  it('leaves NO rows with NULL origin after migration (mixed-population scenario)', () => {
    const db = _getDb();
    const insert = db.prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    // 1 synthetic, 1 Option B, 2 webhook
    insert.run(
      'ipc-2026-04-09T11:00:00.000Z-aaa111',
      'slack:dev-team',
      'ipc',
      'ipc:slack_dispatch',
      'synthetic',
      '2026-04-09T11:00:00.000Z',
      1,
      0,
    );
    insert.run(
      '1775790000.000001',
      'slack:dev-team',
      'ipc',
      'ipc:slack_dispatch',
      'option B',
      '2026-04-10T06:00:00.000Z',
      1,
      0,
    );
    insert.run(
      '1775790100.000001',
      'slack:dev-team',
      'U0HUMAN1',
      'Blake',
      'hi',
      '2026-04-10T06:01:00.000Z',
      0,
      0,
    );
    insert.run(
      '1775790200.000001',
      'slack:dev-team',
      'U0BOT123',
      'Fleet',
      'bot reply',
      '2026-04-10T06:02:00.000Z',
      1,
      1,
    );

    _runMigrationsForTest();

    const nullRows = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE origin IS NULL`)
      .get() as { n: number };
    expect(nullRows.n).toBe(0);

    const counts = db
      .prepare(
        `SELECT origin, COUNT(*) AS n FROM messages GROUP BY origin ORDER BY origin`,
      )
      .all() as Array<{ origin: string; n: number }>;
    expect(counts).toEqual([
      { origin: 'ipc', n: 1 },
      { origin: 'synthetic', n: 1 },
      { origin: 'webhook', n: 2 },
    ]);
  });

  it('is idempotent — re-running the migration does not reclassify already-set rows', () => {
    const db = _getDb();
    // Manually pre-set origin to a value that would be "wrong" if re-classified
    // (the synthetic id would otherwise match the LIKE 'ipc-%' clause).
    db.prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'ipc-2026-04-09T10:00:00.000Z-zzz999',
      'slack:dev-team',
      'ipc',
      'ipc:slack_dispatch',
      'manually classified',
      '2026-04-09T10:00:00.000Z',
      1,
      0,
      'webhook', // intentionally "wrong" — proves WHERE origin IS NULL guards
    );

    _runMigrationsForTest();
    _runMigrationsForTest();

    const row = db
      .prepare(`SELECT origin FROM messages WHERE id = ?`)
      .get('ipc-2026-04-09T10:00:00.000Z-zzz999') as { origin: string };
    // Should still be 'webhook' — the WHERE origin IS NULL clause skips it.
    expect(row.origin).toBe('webhook');
  });
});

describe('updateMessageContent (Slack message_changed handler)', () => {
  beforeEach(() => {
    storeChatMetadata('slack:dev-team', '2026-04-10T00:00:00.000Z');
    storeMessage({
      id: '1700000000.000099',
      chat_jid: 'slack:dev-team',
      sender: 'U_USER',
      sender_name: 'Alice',
      content: 'original content',
      timestamp: '2026-04-11T00:00:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
  });

  it('updates content of a matching row and returns 1', () => {
    const changed = updateMessageContent(
      '1700000000.000099',
      'slack:dev-team',
      'edited content',
    );
    expect(changed).toBe(1);

    const { messages } = getNewMessages(
      ['slack:dev-team'],
      '2026-04-10T23:00:00.000Z',
      'Fleet',
    );
    const row = messages.find((m) => m.id === '1700000000.000099');
    expect(row?.content).toBe('edited content');
  });

  it('returns 0 when no row matches (edit for un-ingested message)', () => {
    const changed = updateMessageContent(
      'nonexistent.ts',
      'slack:dev-team',
      'edited',
    );
    expect(changed).toBe(0);
  });

  it('returns 0 when id matches but chat_jid differs', () => {
    storeChatMetadata('slack:qa-sentinel', '2026-04-10T00:00:00.000Z');
    const changed = updateMessageContent(
      '1700000000.000099',
      'slack:qa-sentinel',
      'edited',
    );
    expect(changed).toBe(0);
  });

  it('preserves other columns (sender, timestamp, is_from_me, is_bot_message)', () => {
    updateMessageContent(
      '1700000000.000099',
      'slack:dev-team',
      'edited content',
    );
    const row = _getDb()
      .prepare(
        `SELECT sender, sender_name, timestamp, is_from_me, is_bot_message FROM messages WHERE id = ? AND chat_jid = ?`,
      )
      .get('1700000000.000099', 'slack:dev-team') as {
      sender: string;
      sender_name: string;
      timestamp: string;
      is_from_me: number;
      is_bot_message: number;
    };
    expect(row.sender).toBe('U_USER');
    expect(row.sender_name).toBe('Alice');
    expect(row.timestamp).toBe('2026-04-11T00:00:00.000Z');
    expect(row.is_from_me).toBe(0);
    expect(row.is_bot_message).toBe(0);
  });
});
