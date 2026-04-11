import { describe, it, expect, vi } from 'vitest';

// Pin ASSISTANT_NAME so the tests don't drift with the deployed config.
// Must be declared BEFORE the ./ipc-inject.js import so the mock applies
// when ipc-inject.ts pulls TRIGGER_PATTERN/ASSISTANT_NAME from config.
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Fleet',
  TRIGGER_PATTERN: /^@Fleet\b/i,
}));

import {
  buildInjectedMessage,
  injectIpcMessage,
  resolveOutboundThreadOpts,
  shouldDropBotEchoForIpcInjection,
  translateMentionToTrigger,
} from './ipc-inject.js';
import { NewMessage } from './types.js';

// --- translateMentionToTrigger ---

describe('translateMentionToTrigger', () => {
  it('prepends @Fleet when content has a Slack mention but no trigger', () => {
    expect(
      translateMentionToTrigger('<@U0AK0PRUFTM> [DISPATCH-ROUTED] task'),
    ).toBe('@Fleet <@U0AK0PRUFTM> [DISPATCH-ROUTED] task');
  });

  it('prepends @Fleet for <@UID|DisplayName> mentions', () => {
    expect(translateMentionToTrigger('<@U0AK0PRUFTM|Agent Fleet> work')).toBe(
      '@Fleet <@U0AK0PRUFTM|Agent Fleet> work',
    );
  });

  it('does not double-prefix content already starting with @Fleet', () => {
    expect(translateMentionToTrigger('@Fleet [DISPATCH-ROUTED] task')).toBe(
      '@Fleet [DISPATCH-ROUTED] task',
    );
  });

  it('does not modify content with no Slack mention', () => {
    expect(translateMentionToTrigger('Just a regular message')).toBe(
      'Just a regular message',
    );
  });

  it('handles empty string', () => {
    expect(translateMentionToTrigger('')).toBe('');
  });
});

// --- buildInjectedMessage ---

describe('buildInjectedMessage', () => {
  it('uses realTs as the id when provided (Option B happy path)', () => {
    const row = buildInjectedMessage({
      chatJid: 'slack:dev-team',
      text: '@Fleet [DISPATCH-ROUTED] work',
      senderName: 'ipc:slack_dispatch',
      realTs: '1775796300.543699',
      now: '2026-04-10T12:00:00.000Z',
      rand: 'abc123',
    });
    expect(row.id).toBe('1775796300.543699');
    expect(row.chat_jid).toBe('slack:dev-team');
    expect(row.sender).toBe('ipc');
    expect(row.sender_name).toBe('ipc:slack_dispatch');
    expect(row.is_from_me).toBe(true);
    expect(row.is_bot_message).toBe(false);
    expect(row.origin).toBe('ipc');
  });

  it('falls back to a synthetic ipc- id when realTs is undefined', () => {
    const row = buildInjectedMessage({
      chatJid: 'slack:dev-team',
      text: '@Fleet work',
      senderName: 'ipc:slack_dispatch',
      realTs: undefined,
      now: '2026-04-10T12:00:00.000Z',
      rand: 'abc123',
    });
    expect(row.id).toBe('ipc-2026-04-10T12:00:00.000Z-abc123');
    expect(row.origin).toBe('synthetic');
  });

  it('translates raw <@UID> mentions before storing', () => {
    const row = buildInjectedMessage({
      chatJid: 'slack:dev-team',
      text: '<@U0AK0PRUFTM> [DISPATCH-ROUTED] new ticket',
      senderName: 'ipc:slack_dispatch',
      realTs: '1775796300.543699',
      now: '2026-04-10T12:00:00.000Z',
      rand: 'xyz789',
    });
    expect(row.content).toBe(
      '@Fleet <@U0AK0PRUFTM> [DISPATCH-ROUTED] new ticket',
    );
  });

  it('uses realTs even when text contains a mention (no id mutation)', () => {
    const row = buildInjectedMessage({
      chatJid: 'slack:dev-team',
      text: '<@U0AK0PRUFTM> work',
      senderName: 'ipc:slack_dispatch',
      realTs: '1775796300.543699',
      now: '2026-04-10T12:00:00.000Z',
      rand: 'xyz789',
    });
    // realTs is the row id; mention translation only affects content
    expect(row.id).toBe('1775796300.543699');
    expect(row.content.startsWith('@Fleet')).toBe(true);
  });

  it('uses now as the timestamp', () => {
    const row = buildInjectedMessage({
      chatJid: 'slack:dev-team',
      text: '@Fleet work',
      senderName: 'ipc:slack_dispatch',
      realTs: '1775796300.543699',
      now: '2026-04-10T12:00:00.000Z',
      rand: 'abc123',
    });
    expect(row.timestamp).toBe('2026-04-10T12:00:00.000Z');
  });
});

// --- injectIpcMessage ---

describe('injectIpcMessage', () => {
  it('calls storeMessage with the built row and enqueues the target group', () => {
    const storeMessage = vi.fn();
    const enqueueMessageCheck = vi.fn();
    injectIpcMessage(
      {
        storeMessage,
        enqueueMessageCheck,
        now: () => '2026-04-10T12:00:00.000Z',
        rand: () => 'abc123',
      },
      'slack:dev-team',
      '@Fleet [DISPATCH-ROUTED] work',
      'ipc:slack_dispatch',
      '1775796300.543699',
    );
    expect(storeMessage).toHaveBeenCalledOnce();
    const row = storeMessage.mock.calls[0][0];
    expect(row.id).toBe('1775796300.543699');
    expect(row.sender).toBe('ipc');
    expect(enqueueMessageCheck).toHaveBeenCalledWith('slack:dev-team');
  });

  it('falls back to synthetic id when realTs is undefined', () => {
    const storeMessage = vi.fn();
    const enqueueMessageCheck = vi.fn();
    injectIpcMessage(
      {
        storeMessage,
        enqueueMessageCheck,
        now: () => '2026-04-10T12:00:00.000Z',
        rand: () => 'fallbk',
      },
      'slack:dev-team',
      '@Fleet work',
      'ipc:slack_dispatch',
      undefined,
    );
    const row = storeMessage.mock.calls[0][0];
    expect(row.id).toBe('ipc-2026-04-10T12:00:00.000Z-fallbk');
  });

  it('translates Slack mentions before storing', () => {
    const storeMessage = vi.fn();
    injectIpcMessage(
      {
        storeMessage,
        enqueueMessageCheck: vi.fn(),
        now: () => '2026-04-10T12:00:00.000Z',
        rand: () => 'abc123',
      },
      'slack:dev-team',
      '<@U0AK0PRUFTM> [DISPATCH-ROUTED] new ticket',
      'ipc:slack_dispatch',
      '1775796300.543699',
    );
    const row = storeMessage.mock.calls[0][0];
    expect(row.content).toBe(
      '@Fleet <@U0AK0PRUFTM> [DISPATCH-ROUTED] new ticket',
    );
  });

  it('always enqueues regardless of realTs', () => {
    const enqueueMessageCheck = vi.fn();
    injectIpcMessage(
      {
        storeMessage: vi.fn(),
        enqueueMessageCheck,
      },
      'slack:dev-team',
      '@Fleet work',
      'ipc:slack_dispatch',
      undefined,
    );
    expect(enqueueMessageCheck).toHaveBeenCalledOnce();
  });

  it('uses real Date/Math when now/rand are not provided', () => {
    // Smoke test — just verifies the production defaults don't crash
    const storeMessage = vi.fn();
    expect(() =>
      injectIpcMessage(
        { storeMessage, enqueueMessageCheck: vi.fn() },
        'slack:dev-team',
        '@Fleet work',
        'ipc:slack_dispatch',
        undefined,
      ),
    ).not.toThrow();
    const row = storeMessage.mock.calls[0][0];
    // Synthetic id format: ipc-{ISO}-{6 alphanumeric}
    expect(row.id).toMatch(
      /^ipc-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[a-z0-9]{6}$/,
    );
  });
});

// --- shouldDropBotEchoForIpcInjection ---

describe('shouldDropBotEchoForIpcInjection', () => {
  function makeMsg(overrides: Partial<NewMessage>): NewMessage {
    return {
      id: '1775796300.543699',
      chat_jid: 'slack:dev-team',
      sender: 'U0BOT123',
      sender_name: 'Fleet',
      content: 'output',
      timestamp: '2026-04-10T12:00:00.000Z',
      is_from_me: true,
      is_bot_message: true,
      ...overrides,
    };
  }

  it('drops bot echo when isIpcInjected returns true', () => {
    const isIpcInjected = vi.fn(() => true);
    expect(
      shouldDropBotEchoForIpcInjection(
        makeMsg({ is_bot_message: true }),
        isIpcInjected,
      ),
    ).toBe(true);
    expect(isIpcInjected).toHaveBeenCalledWith(
      '1775796300.543699',
      'slack:dev-team',
    );
  });

  it('keeps bot echo when isIpcInjected returns false', () => {
    expect(
      shouldDropBotEchoForIpcInjection(
        makeMsg({ is_bot_message: true }),
        () => false,
      ),
    ).toBe(false);
  });

  it('keeps user message regardless of isIpcInjected (never queries it)', () => {
    const isIpcInjected = vi.fn(() => true);
    expect(
      shouldDropBotEchoForIpcInjection(
        makeMsg({ is_bot_message: false }),
        isIpcInjected,
      ),
    ).toBe(false);
    // Optimization: don't query the DB for user messages
    expect(isIpcInjected).not.toHaveBeenCalled();
  });
});

// --- resolveOutboundThreadOpts ---
// Regression suite for the "stream crossing" bug where fresh channel posts
// (dispatch routing messages, cron digests) were forcibly threaded under
// whatever the latest trigger ts happened to be in the target channel.
//
// The rule: only REFRESH a caller-specified threadTs. Never FORCE one on
// a caller that didn't ask for threading.

describe('resolveOutboundThreadOpts (thread crossing regression guard)', () => {
  describe('caller did not ask for threading — must NEVER add threadTs', () => {
    it('opts=undefined, latestThreadTs=undefined → returns undefined', () => {
      expect(resolveOutboundThreadOpts(undefined, undefined)).toBeUndefined();
    });

    it('opts=undefined, latestThreadTs set → returns undefined (NO override)', () => {
      // THE critical regression case: dispatch writes an IPC file with no
      // threadTs field → opts is undefined here → must pass through unchanged
      // even if latestThreadTs is set from a previous injection in the target.
      expect(
        resolveOutboundThreadOpts(undefined, '1775848377.714869'),
      ).toBeUndefined();
    });

    it('opts={}, latestThreadTs set → returns {} (NO override)', () => {
      // Caller passed an empty opts bag (explicitly no threadTs) — still
      // must not inherit latestThreadTs. Otherwise dispatch routing gets
      // threaded under an unrelated older trigger.
      const result = resolveOutboundThreadOpts({}, '1775848377.714869');
      expect(result).toEqual({});
      expect(result?.threadTs).toBeUndefined();
    });

    it('opts with other fields but no threadTs → other fields preserved, no threadTs added', () => {
      const result = resolveOutboundThreadOpts(
        { threadTs: undefined } as { threadTs?: string },
        '1775848377.714869',
      );
      expect(result?.threadTs).toBeUndefined();
    });
  });

  describe('caller asked for threading — refresh behavior preserved', () => {
    it('opts.threadTs set, latestThreadTs unset → keeps caller threadTs', () => {
      expect(
        resolveOutboundThreadOpts({ threadTs: '1775796300.543699' }, undefined),
      ).toEqual({ threadTs: '1775796300.543699' });
    });

    it('opts.threadTs set, latestThreadTs set → refreshes to latestThreadTs', () => {
      // Original intent of the override: container baked a stale ts from
      // session start; refresh to the newest trigger the poller has seen.
      const result = resolveOutboundThreadOpts(
        { threadTs: '1775796300.543699' },
        '1775858500.000001',
      );
      expect(result).toEqual({ threadTs: '1775858500.000001' });
    });

    it('opts.threadTs and latestThreadTs identical → idempotent', () => {
      expect(
        resolveOutboundThreadOpts(
          { threadTs: '1775796300.543699' },
          '1775796300.543699',
        ),
      ).toEqual({ threadTs: '1775796300.543699' });
    });

    it('preserves other opts fields when refreshing threadTs', () => {
      // Guards against a future caller adding new opts fields — the override
      // must spread them through.
      type OptsWithExtras = { threadTs?: string; blocks?: unknown[] };
      const result = resolveOutboundThreadOpts(
        { threadTs: 'T1', blocks: [{ type: 'section' }] } as OptsWithExtras,
        'T2',
      ) as OptsWithExtras;
      expect(result.threadTs).toBe('T2');
      expect(result.blocks).toEqual([{ type: 'section' }]);
    });
  });

  describe('regression — specific failure modes this guard prevents', () => {
    it('dispatch routing scenario: cross-group fresh post does not inherit target channel trigger', () => {
      // Repro of the production bug on 2026-04-10:
      // - Dispatch writes an IPC file with no threadTs (fresh routing post)
      // - latestThreadTs[target_jid] = real ts of a previous IPC injection
      // - Expected: new routing message posts as a FRESH channel message
      // - Previous buggy behavior: new routing threaded under the prior ts
      const dispatchIpcOpts = undefined; // dispatch never sets threadTs for routing
      const staleLatestForTarget = '1775848377.714869'; // deploy test ts
      const resolved = resolveOutboundThreadOpts(
        dispatchIpcOpts,
        staleLatestForTarget,
      );
      expect(resolved).toBeUndefined(); // posts to channel, not to thread
    });

    it('container self-reply scenario: threadTs IS refreshed for same-channel replies', () => {
      // The original intent of the override: container baked a stale ts,
      // refresh to the current newest trigger in the channel. This path
      // must still work after the fix.
      const containerBakedOpts = { threadTs: '1775800000.000000' }; // stale
      const currentLatest = '1775850000.000000'; // newer
      expect(
        resolveOutboundThreadOpts(containerBakedOpts, currentLatest),
      ).toEqual({ threadTs: '1775850000.000000' });
    });

    it('cron digest scenario: scheduled task output posts fresh to its target channel', () => {
      // Cron-spawned container with NANOCLAW_THREAD_TS unset → MCP send_message
      // tool doesn't bake threadTs → IPC file has no threadTs → opts is
      // undefined when the closure runs. Must NOT inherit latestThreadTs.
      expect(
        resolveOutboundThreadOpts(undefined, '1775800000.000000'),
      ).toBeUndefined();
    });
  });
});
