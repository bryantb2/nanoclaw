/**
 * Pure helpers for the IPC message injection path (Option B threading).
 *
 * Extracted from inline closures in index.ts so the load-bearing decisions
 * — "what id does this row get?" and "should the Slack webhook echo be
 * dropped?" — can be unit-tested directly.
 */

import { ASSISTANT_NAME, TRIGGER_PATTERN } from './config.js';
import { MessageOrigin, NewMessage } from './types.js';

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
  // Origin is determined by whether sendMessage returned a usable ts:
  //   - real ts present → 'ipc' (Option B threading works for this row)
  //   - ts absent       → 'synthetic' (Option A fallback — filtered by
  //                       thread anchor selection so reply posts to channel)
  const origin: MessageOrigin = args.realTs ? 'ipc' : 'synthetic';
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
    origin,
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
 *
 * `sameGroupSelfEmission` controls whether to wake the queue. When true
 * (the agent posted to its own group's channel via send_message), the
 * queue wake-up is skipped — the agent is already running and waking the
 * queue would fire `onMessageQueued` and surface a misleading "Queued"
 * acknowledgment for the agent's own self-emission. When false (cross-group
 * routing — e.g., dispatch sending to dev-team), the wake-up is required so
 * the target group picks up the new trigger.
 */
export function injectIpcMessage(
  deps: InjectIpcMessageDeps,
  chatJid: string,
  text: string,
  senderName: string,
  realTs?: string,
  sameGroupSelfEmission: boolean = false,
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
  if (!sameGroupSelfEmission) {
    deps.enqueueMessageCheck(chatJid);
  }
}

/**
 * Resolve the `thread_ts` for an outbound IPC-routed message.
 *
 * The rule: **only refresh a caller-specified `threadTs`** — never force one
 * on a caller that did not ask for threading. This prevents "stream crossing"
 * bugs where fresh channel posts (dispatch routing messages, cron digests,
 * new-topic messages) get forcibly threaded under whatever the latest trigger
 * in the target channel happens to be.
 *
 * Semantics:
 *
 * - `opts.threadTs` set + `latestThreadTs` set → refresh to `latestThreadTs`
 *   (this is the original "container baked a stale ts, refresh to the latest
 *   trigger the poller saw" case for self-replies)
 * - `opts.threadTs` set + `latestThreadTs` unset → keep caller's `threadTs`
 * - `opts.threadTs` unset (or `opts` undefined) → **never** inject `threadTs`
 *   regardless of `latestThreadTs`. The caller is making a fresh channel post.
 *
 * Background: Option B (PR #31) made `latestThreadTs` populate from real
 * Slack ts values on IPC-injected rows. The old closure in `index.ts`
 * unconditionally overrode `opts` with `latestThreadTs[jid]`, which combined
 * with Option B to forcibly thread every dispatch routing message under the
 * most recent IPC injection in the target channel. That's the bug this
 * helper fixes.
 */
export function resolveOutboundThreadOpts(
  opts: { threadTs?: string } | undefined,
  latestThreadTs: string | undefined,
): { threadTs?: string } | undefined {
  if (opts?.threadTs && latestThreadTs) {
    return { ...opts, threadTs: latestThreadTs };
  }
  return opts;
}
