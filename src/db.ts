import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR, TIMEZONE } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  MessageOrigin,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      origin TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS in_flight_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT,
      original_message TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS cost_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      run_at TEXT NOT NULL DEFAULT (datetime('now')),
      cost_usd REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cost_log_run_at ON cost_log(run_at);

    CREATE TABLE IF NOT EXISTS completion_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      run_at TEXT NOT NULL DEFAULT (datetime('now')),
      linear_ticket_id TEXT,
      pr_url TEXT,
      branch_name TEXT,
      repo TEXT,
      test_pass_count INTEGER,
      test_fail_count INTEGER,
      coverage_before REAL,
      coverage_after REAL,
      coverage_delta REAL,
      screenshot_paths TEXT,
      qa_sign_off TEXT,
      cost_usd REAL NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      wall_clock_ms INTEGER,
      tool_call_count INTEGER,
      dispatch_routed INTEGER DEFAULT 0,
      team_task INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_completion_records_run_at ON completion_records(run_at);
    CREATE INDEX IF NOT EXISTS idx_completion_records_group ON completion_records(group_folder);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add origin column to messages. Classifies each row as:
  //   'webhook'   — inbound user/bot message from a Slack/Telegram webhook
  //   'ipc'       — injected by IPC routing with a real platform ts as id
  //                 (Option B, PR #31)
  //   'synthetic' — injected by IPC routing with a synthetic ipc- id
  //                 (fallback when the channel had no usable ts)
  //
  // Pre-Option-B rows used sender='ipc' with id LIKE 'ipc-%' — those are
  // backfilled to 'synthetic'. Rows with sender='ipc' but a real ts id are
  // the post-Option-B injections (no such rows existed before PR #31).
  // Everything else came from a webhook.
  //
  // The origin column replaces the fragile id-prefix string check that
  // isValidThreadTs and isIpcInjectedMessage relied on.
  //
  // The ALTER is wrapped in its own try/catch so "column already exists" is
  // silently tolerated (fresh-schema path + re-run idempotency). Backfill
  // UPDATEs run UNGUARDED so any real failure surfaces in journalctl instead
  // of leaving rows with origin IS NULL — which would silently break the
  // webhook echo race guard (PR #36) for pre-migration Option B rows.
  //
  // SAFETY PRECONDITION: this unguarded backfill assumes restart-fleet.sh
  // kills all agent containers BEFORE starting NanoClaw, so no concurrent
  // writers are present during migration. Container writes during the
  // backfill window could trigger SQLITE_BUSY (busy_timeout=5000ms in
  // initDatabase), and because the UPDATEs are unguarded, an unhandled
  // SQLITE_BUSY would crash NanoClaw boot. If you ever change
  // restart-fleet.sh to skip the container kill, wrap each UPDATE in its
  // own try/catch with logger.warn() instead.
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN origin TEXT`);
  } catch {
    /* column already exists — backfill below is still safe + idempotent */
  }
  // Backfill in priority order so each row gets exactly one classification.
  // All three UPDATEs are idempotent (the `origin IS NULL` guard makes
  // re-runs no-ops) so running them on every startup is safe and cheap.
  // 1. Synthetic IPC rows (id starts with 'ipc-')
  database.exec(
    `UPDATE messages SET origin = 'synthetic' WHERE origin IS NULL AND id LIKE 'ipc-%'`,
  );
  // 2. Real-ts IPC injections (sender='ipc' but id is a real ts)
  database.exec(
    `UPDATE messages SET origin = 'ipc' WHERE origin IS NULL AND sender = 'ipc'`,
  );
  // 3. Everything else came from a webhook
  database.exec(`UPDATE messages SET origin = 'webhook' WHERE origin IS NULL`);

  // Add max_budget_usd column to scheduled_tasks if it doesn't exist
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN max_budget_usd REAL`);
  } catch {
    /* column already exists */
  }

  // Add suppress_output column to scheduled_tasks if it doesn't exist
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN suppress_output INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add started_at column to in_flight_tasks if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE in_flight_tasks ADD COLUMN started_at TEXT DEFAULT (datetime('now'))`,
    );
  } catch {
    /* column already exists */
  }

  // Add token tracking columns to cost_log (migration for existing DBs)
  // Each ALTER in its own try/catch so partial migrations don't skip remaining columns
  for (const col of [
    `input_tokens INTEGER DEFAULT 0`,
    `output_tokens INTEGER DEFAULT 0`,
    `cache_creation_tokens INTEGER DEFAULT 0`,
    `cache_read_tokens INTEGER DEFAULT 0`,
    `cost_source TEXT DEFAULT 'sdk'`,
  ]) {
    try {
      database.exec(`ALTER TABLE cost_log ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }

  // Add run_id to cost_log and task_run_logs for work association
  try {
    database.exec(`ALTER TABLE cost_log ADD COLUMN run_id TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE task_run_logs ADD COLUMN run_id TEXT`);
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. Returns the current database instance. */
export function _getDb(): Database.Database {
  return db;
}

/**
 * @internal - for tests only. Opens a file-based database at the given path,
 * without any pragmas. Use this to test the busy_timeout pragma contract:
 * this helper intentionally mirrors the pre-pragma state of initDatabase().
 */
export function _initFileDatabaseForTest(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  createSchema(db);
}

/**
 * @internal - for tests only. Re-runs createSchema (CREATE IF NOT EXISTS +
 * idempotent migrations + backfill UPDATEs) against the current DB so a test
 * can simulate the "restart against a pre-migration prod DB" scenario.
 */
export function _runMigrationsForTest(): void {
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Returns true if a row at (id, chat_jid) already exists with origin='ipc'
 * — i.e. the row was written by the IPC injection path with a real
 * platform ts as id (Option B, PR #31).
 *
 * Used by the Slack webhook echo handler to skip re-ingesting the bot's own
 * message when IPC already stored it. Without this guard, the echo would
 * `INSERT OR REPLACE` the injected row with `is_bot_message=1` — which
 * `getNewMessages` filters out, silently dropping the dispatched trigger.
 *
 * Note: origin='synthetic' rows (ipc-{iso}-{rand} id) are NOT considered
 * IPC-injected for this check. Synthetic rows have a fabricated id that
 * Slack will never echo back, so there's no collision to guard against.
 */
export function isIpcInjectedMessage(id: string, chatJid: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM messages WHERE id = ? AND chat_jid = ? AND origin = 'ipc' LIMIT 1`,
    )
    .get(id, chatJid);
  return row !== undefined;
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 *
 * `origin` defaults to 'webhook' when not supplied — that's the right
 * default for Slack/Telegram inbound messages which compose the bulk of
 * callers. IPC injection paths explicitly pass 'ipc' or 'synthetic'.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.origin ?? 'webhook',
  );
}

/**
 * Update the `content` field of an existing message row. Used by the
 * Slack `message_changed` event handler so the DB stays in sync with
 * user edits in Slack. Returns the number of rows affected (0 if no
 * matching row exists — e.g. the edit arrived for a message we never
 * ingested).
 */
export function updateMessageContent(
  id: string,
  chatJid: string,
  content: string,
): number {
  const result = db
    .prepare(`UPDATE messages SET content = ? WHERE id = ? AND chat_jid = ?`)
    .run(content, id, chatJid);
  return result.changes;
}

/**
 * Store a message directly — delegates to storeMessage to avoid SQL duplication.
 * Accepts an inline type for callers that don't import NewMessage.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  origin?: MessageOrigin;
}): void {
  storeMessage(msg as NewMessage);
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  // `origin` is included so callers can distinguish webhook/ipc/synthetic
  // rows on read (PR #36 added the column on the write side; the SELECT
  // lists were updated separately to avoid silent `undefined` reads).
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, origin
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  // `origin` is included so callers can distinguish webhook/ipc/synthetic
  // rows on read (mirror of getNewMessages above).
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, origin
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  // Compute next_run if not provided for recurring tasks.
  // Prevents silent scheduling failures where tasks are created
  // as 'active' but never fire because getDueTasks requires
  // next_run IS NOT NULL.
  let nextRun = task.next_run;
  if (!nextRun && task.status === 'active') {
    if (task.schedule_type === 'cron') {
      try {
        const interval = CronExpressionParser.parse(task.schedule_value, {
          tz: TIMEZONE,
        });
        nextRun = interval.next().toISOString();
      } catch {
        logger.error(
          { taskId: task.id, scheduleValue: task.schedule_value },
          'createTask: invalid cron expression — task will never fire (next_run is null)',
        );
      }
    } else if (task.schedule_type === 'interval') {
      const ms = parseInt(task.schedule_value, 10);
      if (!isNaN(ms) && ms > 0) {
        nextRun = new Date(Date.now() + ms).toISOString();
      }
    } else if (task.schedule_type === 'once') {
      const date = new Date(task.schedule_value);
      if (!isNaN(date.getTime())) {
        nextRun = date.toISOString();
      }
    }
  }

  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, max_budget_usd, suppress_output)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    nextRun,
    task.status,
    task.created_at,
    task.max_budget_usd ?? null,
    task.suppress_output ? 1 : 0,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
      | 'suppress_output'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.suppress_output !== undefined) {
    fields.push('suppress_output = ?');
    values.push(updates.suppress_output ? 1 : 0);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
    log.run_id ?? null,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

/**
 * Returns the JID of the main (isMain=true) registered group, if one exists.
 * Used by the cross-group fleet-event wake-up path to find dispatch's channel
 * without coupling container-runner to the registered_groups map in index.ts.
 *
 * Filters out Slack DM channels (jids prefixed `slack:D...`) since those are
 * private operator conversations, not team-facing dispatch channels — fleet
 * events should go to the public dispatch channel that the team monitors.
 * Picks the most-recently-added eligible main group (matches the typical
 * "DM created first during setup, public dispatch channel registered later"
 * pattern observed in production fleets).
 *
 * Returns undefined if no eligible main group is registered — the wake-up is
 * silently skipped in that case (e.g., test fixtures, fresh installs).
 */
export function findMainGroupJid(): string | undefined {
  const row = db
    .prepare(
      "SELECT jid FROM registered_groups WHERE is_main = 1 AND jid NOT LIKE 'slack:D%' ORDER BY added_at DESC LIMIT 1",
    )
    .get() as { jid: string } | undefined;
  return row?.jid;
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

// --- Cost tracking ---

export interface CostLogEntry {
  costUsd: number;
  runId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  /** 'computed' = from token counts, 'sdk' = from SDK total_cost_usd, 'ipc' = recovered from killed container */
  costSource?: 'computed' | 'sdk' | 'ipc';
}

export function appendCostLog(
  groupFolder: string,
  chatJid: string,
  costUsd: number,
  details?: Omit<CostLogEntry, 'costUsd'>,
): void {
  db.prepare(
    `INSERT INTO cost_log (group_folder, chat_jid, run_at, cost_usd, run_id, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_source)
     VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    groupFolder,
    chatJid,
    costUsd,
    details?.runId ?? null,
    details?.inputTokens ?? 0,
    details?.outputTokens ?? 0,
    details?.cacheCreationTokens ?? 0,
    details?.cacheReadTokens ?? 0,
    details?.costSource ?? 'sdk',
  );
}

export interface CompletionRecordInput {
  groupFolder: string;
  chatJid: string;
  linearTicketId?: string | null;
  prUrl?: string | null;
  branchName?: string | null;
  repo?: string | null;
  testPassCount?: number | null;
  testFailCount?: number | null;
  coverageBefore?: number | null;
  coverageAfter?: number | null;
  coverageDelta?: number | null;
  screenshotPaths?: string[] | null;
  qaSignOff?: 'approved' | 'rejected' | 'pending' | null;
  costUsd: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  wallClockMs?: number | null;
  toolCallCount?: number | null;
  dispatchRouted?: boolean;
  teamTask?: boolean;
}

export function appendCompletionRecord(record: CompletionRecordInput): void {
  db.prepare(
    `INSERT INTO completion_records (
      group_folder, chat_jid, run_at, linear_ticket_id, pr_url, branch_name, repo,
      test_pass_count, test_fail_count, coverage_before, coverage_after, coverage_delta,
      screenshot_paths, qa_sign_off, cost_usd, input_tokens, output_tokens,
      wall_clock_ms, tool_call_count, dispatch_routed, team_task
    ) VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.groupFolder,
    record.chatJid,
    record.linearTicketId ?? null,
    record.prUrl ?? null,
    record.branchName ?? null,
    record.repo ?? null,
    record.testPassCount ?? null,
    record.testFailCount ?? null,
    record.coverageBefore ?? null,
    record.coverageAfter ?? null,
    record.coverageDelta ?? null,
    record.screenshotPaths ? JSON.stringify(record.screenshotPaths) : null,
    record.qaSignOff ?? null,
    record.costUsd,
    record.inputTokens ?? null,
    record.outputTokens ?? null,
    record.wallClockMs ?? null,
    record.toolCallCount ?? null,
    record.dispatchRouted ? 1 : 0,
    record.teamTask ? 1 : 0,
  );
}

export function getCostSummary(groupFolder: string): {
  todayUsd: number;
  weekUsd: number;
  allTimeUsd: number;
} {
  const todayRow = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_log WHERE group_folder = ? AND run_at >= date('now')`,
    )
    .get(groupFolder) as { total: number };
  const weekRow = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_log WHERE group_folder = ? AND run_at >= date('now', '-7 days')`,
    )
    .get(groupFolder) as { total: number };
  const allTimeRow = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_log WHERE group_folder = ?`,
    )
    .get(groupFolder) as { total: number };
  return {
    todayUsd: todayRow.total,
    weekUsd: weekRow.total,
    allTimeUsd: allTimeRow.total,
  };
}

export interface InFlightTask {
  id: number;
  group_folder: string;
  channel_id: string;
  thread_ts: string | null;
  original_message: string | null;
  started_at?: string;
}

export function insertInFlightTask(params: Omit<InFlightTask, 'id'>): number {
  const result = db
    .prepare(
      `INSERT INTO in_flight_tasks (group_folder, channel_id, thread_ts, original_message)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      params.group_folder,
      params.channel_id,
      params.thread_ts ?? null,
      params.original_message ?? null,
    );
  return result.lastInsertRowid as number;
}

export function deleteInFlightTask(id: number): void {
  db.prepare('DELETE FROM in_flight_tasks WHERE id = ?').run(id);
}

export function getInFlightTasksList(): InFlightTask[] {
  return db.prepare('SELECT * FROM in_flight_tasks').all() as InFlightTask[];
}

export function getAndClearInFlightTasks(): InFlightTask[] {
  const rows = db
    .prepare('SELECT * FROM in_flight_tasks')
    .all() as InFlightTask[];
  if (rows.length > 0) {
    db.prepare('DELETE FROM in_flight_tasks').run();
  }
  return rows;
}
