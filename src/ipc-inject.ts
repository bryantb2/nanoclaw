/**
 * Pure helpers for the IPC message injection path (Option B threading).
 *
 * Extracted from inline closures in index.ts so the load-bearing decisions
 * — "what id does this row get?" and "should the Slack webhook echo be
 * dropped?" — can be unit-tested directly.
 */

import { ASSISTANT_NAME, TRIGGER_PATTERN } from './config.js';
import { NewMessage } from './types.js';

/**
 * Translate a Slack `<@UID>` mention to the `@Fleet` trigger format if the
 * content doesn't already start with the trigger. Mirrors the translation
 * the Slack channel adapter applies for inbound messages — IPC injections
 * bypass that adapter so we apply it here.
 */
export function translateMentionToTrigger(text: string): string {
  if (
    !TRIGGER_PATTERN.test(text.trim()) &&
    /<@U[A-Z0-9]+(|[^>]*)?>/.test(text)
  ) {
    return `@${ASSISTANT_NAME} ${text}`;
  }
  return text;
}

/**
 * Build the row that the IPC injection path should write to the messages
 * table. Pure — no DB access — so callers (and tests) can decide how to
 * persist. The `id` is the real platform ts when supplied (Option B), or a
 * synthetic `ipc-{iso}-{rand}` fallback when sendMessage returned undefined.
 *
 * `now` and `rand` are injected for deterministic testing.
 */
export function buildInjectedMessage(args: {
  chatJid: string;
  text: string;
  senderName: string;
  realTs?: string;
  now: string;
  rand: string;
}): NewMessage {
  const content = translateMentionToTrigger(args.text);
  const id = args.realTs ?? `ipc-${args.now}-${args.rand}`;
  return {
    id,
    chat_jid: args.chatJid,
    sender: 'ipc',
    sender_name: args.senderName,
    content,
    timestamp: args.now,
    // is_from_me=true so the trigger sender check passes without requiring
    // 'ipc' in the sender allowlist. is_bot_message=false so getNewMessages
    // includes this row (its WHERE clause excludes bot messages).
    is_from_me: true,
    is_bot_message: false,
  };
}

export interface InjectIpcMessageDeps {
  storeMessage: (msg: NewMessage) => void;
  enqueueMessageCheck: (chatJid: string) => void;
  /** Defaults to a fresh ISO timestamp; injected for tests. */
  now?: () => string;
  /** Defaults to a 6-char base36 random; injected for tests. */
  rand?: () => string;
}

/**
 * Inject an IPC-routed message into the DB and wake the target group's
 * poller. The injected row uses `realTs` as its `messages.id` when supplied
 * (Option B threading) or a synthetic id otherwise (Option A fallback).
 */
export function injectIpcMessage(
  deps: InjectIpcMessageDeps,
  chatJid: string,
  text: string,
  senderName: string,
  realTs?: string,
): void {
  const now = deps.now ? deps.now() : new Date().toISOString();
  const rand = deps.rand ? deps.rand() : Math.random().toString(36).slice(2, 8);
  const row = buildInjectedMessage({
    chatJid,
    text,
    senderName,
    realTs,
    now,
    rand,
  });
  deps.storeMessage(row);
  deps.enqueueMessageCheck(chatJid);
}

/**
 * Returns true when an inbound bot-echo message should be dropped because
 * an IPC injection already owns its (id, chat_jid) row. Without this guard,
 * Slack's webhook would clobber the injected row's `is_bot_message=0` with
 * `is_bot_message=1`, making the dispatched trigger invisible to
 * `getNewMessages` and silently dropping the routed task.
 *
 * The check only fires for bot messages — user messages are never echoes
 * of an IPC injection.
 */
export function shouldDropBotEchoForIpcInjection(
  msg: Pick<NewMessage, 'id' | 'chat_jid' | 'is_bot_message'>,
  isIpcInjected: (id: string, chatJid: string) => boolean,
): boolean {
  if (!msg.is_bot_message) return false;
  return isIpcInjected(msg.id, msg.chat_jid);
}
