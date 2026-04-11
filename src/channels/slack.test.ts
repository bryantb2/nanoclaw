import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
  isIpcInjectedMessage: vi.fn(() => false),
  updateMessageContent: vi.fn(() => 1),
  getInFlightTasksList: vi.fn(() => []),
  getAllTasks: vi.fn(() => []),
}));

// --- @slack/bolt mock ---

type Handler = (...args: any[]) => any;

const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => ({
  App: class MockApp {
    eventHandlers = new Map<string, Handler>();
    token: string;
    appToken: string;

    client = {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'U_BOT_123' }),
      },
      chat: {
        postMessage: vi
          .fn()
          .mockResolvedValue({ ok: true, ts: '1700000000.000001' }),
      },
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [],
          response_metadata: {},
        }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: { real_name: 'Alice Smith', name: 'alice' },
        }),
      },
    };

    constructor(opts: any) {
      this.token = opts.token;
      this.appToken = opts.appToken;
      appRef.current = this;
    }

    commandHandlers = new Map<string, Handler>();

    event(name: string, handler: Handler) {
      this.eventHandlers.set(name, handler);
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    async start() {}
    async stop() {}
  },
  LogLevel: { ERROR: 'error' },
}));

// Mock env
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_APP_TOKEN: 'xapp-test-token',
  }),
}));

import { SlackChannel, SlackChannelOpts } from './slack.js';
import {
  updateChatName,
  isIpcInjectedMessage,
  updateMessageContent,
  getInFlightTasksList,
  getAllTasks,
} from '../db.js';
import { readEnvFile } from '../env.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SlackChannelOpts>,
): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'slack:C0123456789': {
        name: 'Test Channel',
        folder: 'test-channel',
        trigger: '@Jonesy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessageEvent(overrides: {
  channel?: string;
  channelType?: string;
  user?: string;
  text?: string;
  ts?: string;
  threadTs?: string;
  subtype?: string;
  botId?: string;
}) {
  return {
    channel: overrides.channel ?? 'C0123456789',
    channel_type: overrides.channelType ?? 'channel',
    user: overrides.user ?? 'U_USER_456',
    text: 'text' in overrides ? overrides.text : 'Hello everyone',
    ts: overrides.ts ?? '1704067200.000000',
    thread_ts: overrides.threadTs,
    subtype: overrides.subtype,
    bot_id: overrides.botId,
  };
}

function currentApp() {
  return appRef.current;
}

async function triggerMessageEvent(
  event: ReturnType<typeof createMessageEvent>,
) {
  const handler = currentApp().eventHandlers.get('message');
  if (handler) await handler({ event });
}

// --- Tests ---

describe('SlackChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when app starts', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message event handler on construction', () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      expect(currentApp().eventHandlers.has('message')).toBe(true);
    });

    it('gets bot user ID on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();

      expect(currentApp().client.auth.test).toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    beforeEach(() => {
      (isIpcInjectedMessage as ReturnType<typeof vi.fn>).mockReset();
      (isIpcInjectedMessage as ReturnType<typeof vi.fn>).mockReturnValue(false);
    });

    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Hello everyone' });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.any(String),
        undefined,
        'slack',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          id: '1704067200.000000',
          chat_jid: 'slack:C0123456789',
          sender: 'U_USER_456',
          content: 'Hello everyone',
          is_from_me: false,
          origin: 'webhook',
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ channel: 'C9999999999' });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:C9999999999',
        expect.any(String),
        undefined,
        'slack',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips non-text subtypes (channel_join, etc.)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ subtype: 'channel_join' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('allows bot_message subtype through', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_OTHER_BOT',
        text: 'Bot message',
      });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalled();
    });

    it('skips messages with no text', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: undefined as any });
      await triggerMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('detects bot messages by bot_id', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        subtype: 'bot_message',
        botId: 'B_MY_BOT',
        text: 'Bot response',
      });
      await triggerMessageEvent(event);

      // Has bot_id so should be marked as bot message
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
          sender_name: 'Jonesy',
        }),
      );
    });

    it('detects bot messages by matching bot user ID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        user: 'U_BOT_123',
        text: 'Self message',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });

    it('identifies IM channel type as non-group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'slack:D0123456789': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        channel: 'D0123456789',
        channelType: 'im',
      });
      await triggerMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'slack:D0123456789',
        expect.any(String),
        undefined,
        'slack',
        false, // IM is not a group
      );
    });

    it('converts ts to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ ts: '1704067200.000000' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('resolves user name from Slack API', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ user: 'U_USER_456', text: 'Hello' });
      await triggerMessageEvent(event);

      expect(currentApp().client.users.info).toHaveBeenCalledWith({
        user: 'U_USER_456',
      });
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          sender_name: 'Alice Smith',
        }),
      );
    });

    it('caches user names to avoid repeated API calls', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // First message — API call
      await triggerMessageEvent(
        createMessageEvent({ user: 'U_USER_456', text: 'First' }),
      );
      // Second message — should use cache
      await triggerMessageEvent(
        createMessageEvent({
          user: 'U_USER_456',
          text: 'Second',
          ts: '1704067201.000000',
        }),
      );

      expect(currentApp().client.users.info).toHaveBeenCalledTimes(1);
    });

    it('falls back to user ID when API fails', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.users.info.mockRejectedValueOnce(
        new Error('API error'),
      );

      const event = createMessageEvent({ user: 'U_UNKNOWN', text: 'Hi' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          sender_name: 'U_UNKNOWN',
        }),
      );
    });

    it('flattens threaded replies into channel messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067201.000000',
        threadTs: '1704067200.000000', // parent message ts — this is a reply
        text: 'Thread reply',
      });
      await triggerMessageEvent(event);

      // Threaded replies are delivered as regular channel messages
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Thread reply',
        }),
      );
    });

    it('delivers thread parent messages normally', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        ts: '1704067200.000000',
        threadTs: '1704067200.000000', // same as ts — this IS the parent
        text: 'Thread parent',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Thread parent',
        }),
      );
    });

    it('delivers messages without thread_ts normally', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({ text: 'Normal message' });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalled();
    });
  });

  // --- Option B race guard (moved from index.ts onMessage) ---
  // When IPC routing injects a row at (msg.ts, jid) with origin='ipc' and
  // Slack echoes the bot's own post back via the webhook, re-ingesting the
  // echo would clobber the injected row with is_bot_message=1. The Slack
  // adapter checks isIpcInjectedMessage before calling onMessage so the
  // race is handled at the source of bot echoes, not in every channel's
  // generic onMessage path.

  describe('IPC injection webhook echo guard', () => {
    beforeEach(() => {
      (isIpcInjectedMessage as ReturnType<typeof vi.fn>).mockReset();
      (isIpcInjectedMessage as ReturnType<typeof vi.fn>).mockReturnValue(false);
    });

    it('skips onMessage for bot echo when IPC row already owns the id', async () => {
      (isIpcInjectedMessage as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect(); // sets botUserId

      // Bot echo: user is the bot's own id
      const event = createMessageEvent({
        text: 'bot output echoed back',
        user: 'U_BOT_123',
        ts: '1775866368.000529',
      });
      await triggerMessageEvent(event);

      expect(isIpcInjectedMessage).toHaveBeenCalledWith(
        '1775866368.000529',
        'slack:C0123456789',
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('delivers bot echo normally when no IPC row owns the id', async () => {
      (isIpcInjectedMessage as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'bot output (not IPC-owned)',
        user: 'U_BOT_123',
        ts: '1775866400.111111',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          id: '1775866400.111111',
          is_bot_message: true,
          origin: 'webhook',
        }),
      );
    });

    it('never queries isIpcInjectedMessage for user messages (optimization)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'regular user message',
        user: 'U_USER_456', // not the bot
        ts: '1775866500.222222',
      });
      await triggerMessageEvent(event);

      expect(isIpcInjectedMessage).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalled();
    });

    it('delivers bot message with origin=webhook', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'bot output',
        user: 'U_BOT_123',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          origin: 'webhook',
          is_bot_message: true,
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('prepends trigger when bot is @mentioned via Slack format', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect(); // sets botUserId to 'U_BOT_123'

      const event = createMessageEvent({
        text: 'Hey <@U_BOT_123> what do you think?',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '@Jonesy Hey <@U_BOT_123> what do you think?',
        }),
      );
    });

    it('does not prepend trigger when trigger pattern already matches', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: '@Jonesy <@U_BOT_123> hello',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      // Content should be unchanged since it already matches TRIGGER_PATTERN
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: '@Jonesy <@U_BOT_123> hello',
        }),
      );
    });

    it('does not translate mentions in bot messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Echo: <@U_BOT_123>',
        subtype: 'bot_message',
        botId: 'B_MY_BOT',
      });
      await triggerMessageEvent(event);

      // Bot messages skip mention translation
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Echo: <@U_BOT_123>',
        }),
      );
    });

    it('does not translate mentions for other users', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const event = createMessageEvent({
        text: 'Hey <@U_OTHER_USER> look at this',
        user: 'U_USER_456',
      });
      await triggerMessageEvent(event);

      // Mention is for a different user, not the bot
      expect(opts.onMessage).toHaveBeenCalledWith(
        'slack:C0123456789',
        expect.objectContaining({
          content: 'Hey <@U_OTHER_USER> look at this',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via Slack client', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:C0123456789', 'Hello');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Hello',
      });
    });

    it('strips slack: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      await channel.sendMessage('slack:D9876543210', 'DM message');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'D9876543210',
        text: 'DM message',
      });
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Don't connect — should queue
      await channel.sendMessage('slack:C0123456789', 'Queued message');

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('queues message on send failure', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.postMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('slack:C0123456789', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('splits long messages at 4000 character boundary', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Create a message longer than 4000 chars
      const longText = 'A'.repeat(4500);
      await channel.sendMessage('slack:C0123456789', longText);

      // Should be split into 2 messages: 4000 + 500
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(1, {
        channel: 'C0123456789',
        text: 'A'.repeat(4000),
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenNthCalledWith(2, {
        channel: 'C0123456789',
        text: 'A'.repeat(500),
      });
    });

    it('returns the Slack ts from chat.postMessage (Option B)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.postMessage.mockResolvedValueOnce({
        ok: true,
        ts: '1775796300.543699',
      });

      const ts = await channel.sendMessage('slack:C0123456789', 'hello');
      expect(ts).toBe('1775796300.543699');
    });

    it('returns first chunk ts when splitting long messages (Option B)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // First call returns the anchor ts; subsequent calls return different ts
      currentApp()
        .client.chat.postMessage.mockResolvedValueOnce({
          ok: true,
          ts: '1775796300.111111',
        })
        .mockResolvedValueOnce({ ok: true, ts: '1775796300.222222' });

      const ts = await channel.sendMessage(
        'slack:C0123456789',
        'X'.repeat(4500),
      );
      // Subsequent replies thread under the FIRST chunk
      expect(ts).toBe('1775796300.111111');
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(2);
    });

    it('returns undefined when disconnected (message queued)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      // Don't connect
      const ts = await channel.sendMessage('slack:C0123456789', 'queued');
      expect(ts).toBeUndefined();
    });

    it('returns undefined when postMessage throws (error queued)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      currentApp().client.chat.postMessage.mockRejectedValueOnce(
        new Error('Slack API down'),
      );

      const ts = await channel.sendMessage('slack:C0123456789', 'fails');
      expect(ts).toBeUndefined();
    });

    it('sends exactly-4000-char messages as a single message', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const text = 'B'.repeat(4000);
      await channel.sendMessage('slack:C0123456789', text);

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text,
      });
    });

    it('splits messages into 3 parts when over 8000 chars', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const longText = 'C'.repeat(8500);
      await channel.sendMessage('slack:C0123456789', longText);

      // 4000 + 4000 + 500 = 3 messages
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(3);
    });

    it('flushes queued messages on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Queue messages while disconnected
      await channel.sendMessage('slack:C0123456789', 'First queued');
      await channel.sendMessage('slack:C0123456789', 'Second queued');

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();

      // Connect triggers flush
      await channel.connect();

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'First queued',
      });
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Second queued',
      });
    });

    it('preserves threadTs when queuing on disconnect (flush restores threading)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Queue with threadTs while disconnected
      await channel.sendMessage('slack:C0123456789', 'Threaded reply', {
        threadTs: '1700000000.000001',
      });

      expect(currentApp().client.chat.postMessage).not.toHaveBeenCalled();

      await channel.connect();

      // Flushed message must still carry thread_ts — without this the
      // reply would land in the main channel after a transient failure.
      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C0123456789',
        text: 'Threaded reply',
        thread_ts: '1700000000.000001',
      });
    });

    it('preserves threadTs when queuing on postMessage failure', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // Make the initial post fail so the message gets queued
      currentApp().client.chat.postMessage.mockRejectedValueOnce(
        new Error('transient failure'),
      );

      const result = await channel.sendMessage(
        'slack:C0123456789',
        'Threaded update',
        { threadTs: '1700000000.000042' },
      );
      expect(result).toBeUndefined();

      // Subsequent flush (simulated by reconnecting after stub reset) must
      // include thread_ts on the retried message. We just verify the queue
      // item retained threadTs by inspecting the private field.
      const queue = (
        channel as unknown as {
          outgoingQueue: Array<{
            jid: string;
            text: string;
            threadTs?: string;
          }>;
        }
      ).outgoingQueue;
      expect(queue).toHaveLength(1);
      expect(queue[0].threadTs).toBe('1700000000.000042');
      expect(queue[0].text).toBe('Threaded update');
    });

    it('queues only the unsent tail when a split-message chunk fails mid-loop', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      // 9000 chars → 3 chunks of 4000/4000/1000. First 2 succeed, 3rd throws.
      const postMock = currentApp().client.chat.postMessage as ReturnType<
        typeof vi.fn
      >;
      postMock
        .mockResolvedValueOnce({ ok: true, ts: '1700000000.000100' })
        .mockResolvedValueOnce({ ok: true, ts: '1700000000.000200' })
        .mockRejectedValueOnce(new Error('third chunk failed'));

      const text = 'A'.repeat(4000) + 'B'.repeat(4000) + 'C'.repeat(1000);
      const result = await channel.sendMessage('slack:C0123456789', text);
      expect(result).toBeUndefined();

      const queue = (
        channel as unknown as {
          outgoingQueue: Array<{
            jid: string;
            text: string;
            threadTs?: string;
          }>;
        }
      ).outgoingQueue;
      // Only the unsent 3rd chunk ('C' x 1000) should be queued — NOT the
      // full 9000-char text. Otherwise chunks 1 + 2 double-post on retry.
      expect(queue).toHaveLength(1);
      expect(queue[0].text).toBe('C'.repeat(1000));
      expect(queue[0].text.length).toBe(1000);
    });

    it('queues exactly the failed-chunk-onward tail when a MIDDLE chunk fails', async () => {
      // Audit gap fix (mutation survivor #4): the existing partial-fail test
      // only exercises the case where the LAST chunk throws, so a mutation
      // that moves `sentChars = chunkEnd` BEFORE the await would still pass
      // (sentChars would equal text.length at the time of throw because
      // the prior chunks already advanced it). This test exercises a chunk-2
      // failure where the mutation would record sentChars=8000 instead of
      // 4000 — losing the entire 'B' chunk's content.
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const postMock = currentApp().client.chat.postMessage as ReturnType<
        typeof vi.fn
      >;
      // 9000 chars → 3 chunks of 4000/4000/1000. Chunk 1 succeeds, chunk 2 throws.
      postMock
        .mockResolvedValueOnce({ ok: true, ts: '1700000000.000100' })
        .mockRejectedValueOnce(new Error('second chunk failed'));

      const text = 'A'.repeat(4000) + 'B'.repeat(4000) + 'C'.repeat(1000);
      const result = await channel.sendMessage('slack:C0123456789', text);
      expect(result).toBeUndefined();

      const queue = (
        channel as unknown as {
          outgoingQueue: Array<{
            jid: string;
            text: string;
            threadTs?: string;
          }>;
        }
      ).outgoingQueue;
      // The unsent tail must contain BOTH the failed chunk 2 AND chunk 3 —
      // i.e. 'B'*4000 + 'C'*1000 = 5000 chars. If sentChars was incorrectly
      // advanced before the await, the tail would be only 'C'*1000.
      expect(queue).toHaveLength(1);
      expect(queue[0].text).toBe('B'.repeat(4000) + 'C'.repeat(1000));
      expect(queue[0].text.length).toBe(5000);
    });

    it('does not queue anything when the entire split succeeds', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);
      await channel.connect();

      const text = 'X'.repeat(4500); // 2 chunks
      await channel.sendMessage('slack:C0123456789', text);

      const queue = (
        channel as unknown as {
          outgoingQueue: unknown[];
        }
      ).outgoingQueue;
      expect(queue).toHaveLength(0);
    });

    // --- flush resilience (Bug 1: re-split on flush, Bug 2: don't drop on throw) ---

    it('re-splits queued items > MAX_MESSAGE_LENGTH during flush', async () => {
      // Bug 1: previously the flush called chat.postMessage once per item
      // with no re-split. Slack hard-caps individual posts at 4000 chars,
      // so a 5000-char queued tail (which PR #33's partial-fail catch path
      // produces routinely) would soft-fail and be silently lost. The fix
      // routes flush items through sendMessage so they get the same
      // re-split logic that fresh sends use.
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Pre-queue an oversized item by sending while disconnected.
      const oversize = 'A'.repeat(4000) + 'B'.repeat(4000) + 'C'.repeat(1000); // 9000 chars
      await channel.sendMessage('slack:C0123456789', oversize);

      // Connect → flush. The flush MUST split into 3 chunks, not call
      // postMessage with a single 9000-char text.
      await channel.connect();

      const postMock = currentApp().client.chat.postMessage as ReturnType<
        typeof vi.fn
      >;
      const calls = postMock.mock.calls.map(
        (c: unknown[]) => c[0] as { text: string },
      );
      // Every post must respect Slack's per-call cap.
      for (const call of calls) {
        expect(call.text.length).toBeLessThanOrEqual(4000);
      }
      // 9000 chars / 4000 per chunk = 3 chunks for THIS item. There may be
      // additional calls if other tests share state — assert at least 3.
      expect(calls.length).toBeGreaterThanOrEqual(3);
      // Reassemble the chunks: first 4000 'A', next 4000 'B', last 1000 'C'.
      const reassembled = calls
        .slice(-3)
        .map((c) => c.text)
        .join('');
      expect(reassembled).toBe(oversize);
    });

    it('continues flushing remaining items after one item throws', async () => {
      // Bug 2: previously flush used `.shift()` BEFORE `await`, so if
      // postMessage threw on item N, items N+1..end were silently stranded
      // because the catch/finally exited the loop entirely. The fix
      // catches per-item failures and continues with the rest of the
      // snapshot.
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Queue 3 small items while disconnected.
      await channel.sendMessage('slack:C0123456789', 'first');
      await channel.sendMessage('slack:C0123456789', 'second');
      await channel.sendMessage('slack:C0123456789', 'third');

      // Make item 2 fail. Item 1 succeeds. Item 3 must STILL be attempted.
      const postMock = currentApp().client.chat.postMessage as ReturnType<
        typeof vi.fn
      >;
      postMock
        .mockResolvedValueOnce({ ok: true, ts: '1700000000.000001' }) // 1
        .mockRejectedValueOnce(new Error('item 2 failed')) // 2
        .mockResolvedValueOnce({ ok: true, ts: '1700000000.000003' }); // 3

      await channel.connect();

      // All 3 items must have been attempted (1 success + 1 throw + 1
      // success). The pre-fix behavior would have stopped after the throw.
      const sentTexts = postMock.mock.calls.map(
        (c: unknown[]) => (c[0] as { text: string }).text,
      );
      expect(sentTexts).toContain('first');
      expect(sentTexts).toContain('third');

      // Item 2 should have been re-queued by sendMessage's catch path.
      const queue = (
        channel as unknown as {
          outgoingQueue: Array<{ jid: string; text: string }>;
        }
      ).outgoingQueue;
      expect(queue.find((q) => q.text === 'second')).toBeDefined();
      expect(queue.find((q) => q.text === 'first')).toBeUndefined();
      expect(queue.find((q) => q.text === 'third')).toBeUndefined();
    });

    it('flush snapshot prevents infinite re-flush loop on persistent failure', async () => {
      // The snapshot pattern is the third leg of the resilience fix: if
      // sendMessage's catch path re-queues an item during flush, the
      // re-queued item must NOT be picked up by the SAME flush iteration
      // (would loop forever on persistent failure). It should sit in the
      // queue until the NEXT flush trigger.
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await channel.sendMessage('slack:C0123456789', 'persistent-fail');

      // Make EVERY postMessage call reject so the item re-queues on each
      // attempt. If the snapshot pattern is broken, this test hangs (or
      // explodes the queue).
      const postMock = currentApp().client.chat.postMessage as ReturnType<
        typeof vi.fn
      >;
      postMock.mockRejectedValue(new Error('persistent network failure'));

      await channel.connect();

      // Exactly ONE attempt per flush call. The item is back in the queue
      // for the next flush trigger.
      expect(postMock).toHaveBeenCalledTimes(1);

      const queue = (
        channel as unknown as {
          outgoingQueue: Array<{ jid: string; text: string }>;
        }
      ).outgoingQueue;
      expect(queue).toHaveLength(1);
      expect(queue[0].text).toBe('persistent-fail');
    });
  });

  // --- message_changed event handling ---

  describe('message_changed subtype', () => {
    beforeEach(() => {
      (updateMessageContent as ReturnType<typeof vi.fn>).mockClear();
    });

    it('updates DB row content when a message is edited in a registered channel', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      const handler = currentApp().eventHandlers.get('message');
      await handler({
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: 'C0123456789',
          message: {
            ts: '1700000000.000099',
            text: 'edited content',
          },
        },
      });

      expect(updateMessageContent).toHaveBeenCalledWith(
        '1700000000.000099',
        'slack:C0123456789',
        'edited content',
      );
    });

    it('skips message_changed for unregistered channels', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      const handler = currentApp().eventHandlers.get('message');
      await handler({
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: 'C_UNKNOWN',
          message: { ts: '1700000000.000099', text: 'edited' },
        },
      });

      expect(updateMessageContent).not.toHaveBeenCalled();
    });

    it('skips message_changed when embedded message has no text', async () => {
      const opts = createTestOpts();
      new SlackChannel(opts);

      const handler = currentApp().eventHandlers.get('message');
      await handler({
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: 'C0123456789',
          message: { ts: '1700000000.000099' }, // no text field
        },
      });

      expect(updateMessageContent).not.toHaveBeenCalled();
    });

    it('applies empty-string edits (user blanked the message)', async () => {
      // Audit gap fix: the gate is `typeof updated.text === 'string'`, NOT
      // `updated.text` truthy, so an empty-string edit IS valid and should
      // update the DB row. Pin this decision so a refactor to truthy-check
      // doesn't silently regress.
      const opts = createTestOpts();
      new SlackChannel(opts);

      const handler = currentApp().eventHandlers.get('message');
      await handler({
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: 'C0123456789',
          message: { ts: '1700000000.000099', text: '' },
        },
      });

      expect(updateMessageContent).toHaveBeenCalledWith(
        '1700000000.000099',
        'slack:C0123456789',
        '',
      );
    });

    it('applies bot-own-edits to the DB row (current behavior — Fleet edits its own messages)', async () => {
      // Audit gap fix: the handler does NOT filter on `bot_id`, so
      // bot-edited messages (e.g. Fleet calling chat.update on its own
      // output) DO update the DB row. That's intentional — bot edits
      // should be reflected in stored history. Pin this decision so a
      // future "filter out bot edits" refactor would have to update the
      // test deliberately rather than silently regressing.
      const opts = createTestOpts();
      new SlackChannel(opts);

      const handler = currentApp().eventHandlers.get('message');
      await handler({
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: 'C0123456789',
          message: {
            ts: '1700000000.000099',
            text: 'Fleet: revised output',
            bot_id: 'B0FLEET01',
          },
        },
      });

      expect(updateMessageContent).toHaveBeenCalledWith(
        '1700000000.000099',
        'slack:C0123456789',
        'Fleet: revised output',
      );
    });

    it('does NOT call onMessage for message_changed events (no double-storage)', async () => {
      const onMessage = vi.fn();
      const opts = createTestOpts({ onMessage });
      new SlackChannel(opts);

      const handler = currentApp().eventHandlers.get('message');
      await handler({
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: 'C0123456789',
          message: { ts: '1700000000.000099', text: 'edited' },
        },
      });

      // message_changed should ONLY update content, not trigger ingest
      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns slack: JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:C0123456789')).toBe(true);
    });

    it('owns slack: DM JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('slack:D0123456789')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- syncChannelMetadata ---

  describe('syncChannelMetadata', () => {
    it('calls conversations.list and updates chat names', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.conversations.list.mockResolvedValue({
        channels: [
          { id: 'C001', name: 'general', is_member: true },
          { id: 'C002', name: 'random', is_member: true },
          { id: 'C003', name: 'external', is_member: false },
        ],
        response_metadata: {},
      });

      await channel.connect();

      // connect() calls syncChannelMetadata internally
      expect(updateChatName).toHaveBeenCalledWith('slack:C001', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C002', 'random');
      // Non-member channels are skipped
      expect(updateChatName).not.toHaveBeenCalledWith('slack:C003', 'external');
    });

    it('handles API errors gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      currentApp().client.conversations.list.mockRejectedValue(
        new Error('API error'),
      );

      // Should not throw
      await expect(channel.connect()).resolves.toBeUndefined();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('resolves without error (no-op)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // Should not throw — Slack has no bot typing indicator API
      await expect(
        channel.setTyping('slack:C0123456789', true),
      ).resolves.toBeUndefined();
    });

    it('accepts false without error', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      await expect(
        channel.setTyping('slack:C0123456789', false),
      ).resolves.toBeUndefined();
    });
  });

  // --- Constructor error handling ---

  describe('constructor', () => {
    it('throws when SLACK_BOT_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        SLACK_BOT_TOKEN: '',
        SLACK_APP_TOKEN: 'xapp-test-token',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });

    it('throws when SLACK_APP_TOKEN is missing', () => {
      vi.mocked(readEnvFile).mockReturnValueOnce({
        SLACK_BOT_TOKEN: 'xoxb-test-token',
        SLACK_APP_TOKEN: '',
      });

      expect(() => new SlackChannel(createTestOpts())).toThrow(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    });
  });

  // --- syncChannelMetadata pagination ---

  describe('syncChannelMetadata pagination', () => {
    it('paginates through multiple pages of channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel(opts);

      // First page returns a cursor; second page returns no cursor
      currentApp()
        .client.conversations.list.mockResolvedValueOnce({
          channels: [{ id: 'C001', name: 'general', is_member: true }],
          response_metadata: { next_cursor: 'cursor_page2' },
        })
        .mockResolvedValueOnce({
          channels: [{ id: 'C002', name: 'random', is_member: true }],
          response_metadata: {},
        });

      await channel.connect();

      // Should have called conversations.list twice (once per page)
      expect(currentApp().client.conversations.list).toHaveBeenCalledTimes(2);
      expect(currentApp().client.conversations.list).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ cursor: 'cursor_page2' }),
      );

      // Both channels from both pages stored
      expect(updateChatName).toHaveBeenCalledWith('slack:C001', 'general');
      expect(updateChatName).toHaveBeenCalledWith('slack:C002', 'random');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "slack"', () => {
      const channel = new SlackChannel(createTestOpts());
      expect(channel.name).toBe('slack');
    });
  });

  // --- /tasks command ---

  describe('/tasks command', () => {
    async function fireCommand(name: string, opts: SlackChannelOpts) {
      new SlackChannel(opts);
      const handler = currentApp().commandHandlers.get(name);
      if (!handler) throw new Error(`No handler registered for ${name}`);
      const ack = vi.fn().mockResolvedValue(undefined);
      const respond = vi.fn().mockResolvedValue(undefined);
      await handler({ ack, respond, command: { channel_id: 'C0123456789' } });
      return { ack, respond };
    }

    it('registers /tasks command handler', () => {
      new SlackChannel(createTestOpts());
      expect(currentApp().commandHandlers.has('/tasks')).toBe(true);
    });

    it('calls ack() first', async () => {
      const { ack, respond } = await fireCommand('/tasks', createTestOpts());
      expect(ack).toHaveBeenCalled();
      expect(respond).toHaveBeenCalled();
    });

    it('returns ephemeral response', async () => {
      const { respond } = await fireCommand('/tasks', createTestOpts());
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ response_type: 'ephemeral' }),
      );
    });

    it('returns "No tasks running" when no active containers', async () => {
      vi.mocked(getInFlightTasksList).mockReturnValue([]);
      const mockQueue = {
        getActiveState: vi.fn(() => []),
        getActiveCount: vi.fn(() => 0),
      };
      const opts = createTestOpts({ queue: mockQueue as any });
      const { respond } = await fireCommand('/tasks', opts);
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('No tasks running'),
        }),
      );
    });

    it('returns container info when tasks are running', async () => {
      const startedAt = new Date(Date.now() - 90000)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, '');
      vi.mocked(getInFlightTasksList).mockReturnValue([
        {
          id: 1,
          group_folder: 'dev-team',
          channel_id: 'C0123456789',
          thread_ts: null,
          original_message:
            'Build the authentication module for the new API endpoint',
          started_at: startedAt,
        },
      ]);
      const mockQueue = {
        getActiveState: vi.fn(() => [
          {
            groupJid: 'slack:C0123456789',
            containerName: 'nanoclaw-dev-team-1711234567',
            groupFolder: 'dev-team',
            isTaskContainer: false,
            runningTaskId: null,
          },
        ]),
        getActiveCount: vi.fn(() => 1),
      };
      const opts = createTestOpts({ queue: mockQueue as any });
      const { respond } = await fireCommand('/tasks', opts);
      const call = vi.mocked(respond).mock.calls[0][0] as any;
      expect(call.text).toContain('dev-team');
      expect(call.text).toContain('nanoclaw-dev-team-1711234567');
      // Should include truncated message preview
      expect(call.text).toContain('Build the authentication');
    });
  });

  // --- /status command ---

  describe('/status command', () => {
    async function fireCommand(name: string, opts: SlackChannelOpts) {
      new SlackChannel(opts);
      const handler = currentApp().commandHandlers.get(name);
      if (!handler) throw new Error(`No handler registered for ${name}`);
      const ack = vi.fn().mockResolvedValue(undefined);
      const respond = vi.fn().mockResolvedValue(undefined);
      await handler({ ack, respond, command: {} });
      return { ack, respond };
    }

    it('registers /status command handler', () => {
      new SlackChannel(createTestOpts());
      expect(currentApp().commandHandlers.has('/fleet-status')).toBe(true);
    });

    it('returns ephemeral response with uptime and container count', async () => {
      const mockQueue = {
        getActiveState: vi.fn(() => []),
        getActiveCount: vi.fn(() => 2),
      };
      const opts = createTestOpts({ queue: mockQueue as any });
      const { respond } = await fireCommand('/fleet-status', opts);
      const call = vi.mocked(respond).mock.calls[0][0] as any;
      expect(call.response_type).toBe('ephemeral');
      expect(call.text).toContain('Uptime');
      expect(call.text).toContain('2'); // active container count
    });
  });

  // --- /scheduled command ---

  describe('/scheduled command', () => {
    async function fireCommand(name: string, opts: SlackChannelOpts) {
      new SlackChannel(opts);
      const handler = currentApp().commandHandlers.get(name);
      if (!handler) throw new Error(`No handler registered for ${name}`);
      const ack = vi.fn().mockResolvedValue(undefined);
      const respond = vi.fn().mockResolvedValue(undefined);
      await handler({ ack, respond, command: {} });
      return { ack, respond };
    }

    it('registers /scheduled command handler', () => {
      new SlackChannel(createTestOpts());
      expect(currentApp().commandHandlers.has('/scheduled')).toBe(true);
    });

    it('returns "No scheduled tasks" when no active tasks', async () => {
      vi.mocked(getAllTasks).mockReturnValue([]);
      const { respond } = await fireCommand('/scheduled', createTestOpts());
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('No scheduled tasks'),
        }),
      );
    });

    it('returns ephemeral response', async () => {
      vi.mocked(getAllTasks).mockReturnValue([]);
      const { respond } = await fireCommand('/scheduled', createTestOpts());
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ response_type: 'ephemeral' }),
      );
    });

    it('shows scheduled tasks with Mountain Time next run', async () => {
      vi.mocked(getAllTasks).mockReturnValue([
        {
          id: 'task-001',
          group_folder: 'dev-team',
          chat_jid: 'slack:C0123456789',
          prompt: 'Run weekly report',
          schedule_type: 'cron',
          schedule_value: '0 9 * * 1',
          next_run: '2026-04-06T16:00:00.000Z', // 10am MT (UTC-6 MDT)
          last_run: null,
          last_result: null,
          status: 'active',
          created_at: '2026-03-01T00:00:00.000Z',
          context_mode: 'isolated',
          max_budget_usd: null,
        },
      ]);
      const { respond } = await fireCommand('/scheduled', createTestOpts());
      const call = vi.mocked(respond).mock.calls[0][0] as any;
      expect(call.text).toContain('dev-team');
      expect(call.text).toContain('0 9 * * 1');
      // Should show time in Mountain Time (not UTC)
      expect(call.text).not.toContain('16:00');
    });

    it('filters out inactive tasks', async () => {
      vi.mocked(getAllTasks).mockReturnValue([
        {
          id: 'task-inactive',
          group_folder: 'dev-team',
          chat_jid: 'slack:C0123456789',
          prompt: 'Inactive task',
          schedule_type: 'cron',
          schedule_value: '0 9 * * 1',
          next_run: '2026-04-06T16:00:00.000Z',
          last_run: null,
          last_result: null,
          status: 'paused',
          created_at: '2026-03-01T00:00:00.000Z',
          context_mode: 'isolated',
          max_budget_usd: null,
        },
      ]);
      const { respond } = await fireCommand('/scheduled', createTestOpts());
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('No scheduled tasks'),
        }),
      );
    });
  });

  // --- /cancel command ---

  describe('/cancel command', () => {
    async function fireCommandWithQueue(text: string, queueOverride: any) {
      const opts = createTestOpts({ queue: queueOverride });
      new SlackChannel(opts);
      const handler = currentApp().commandHandlers.get('/cancel');
      if (!handler) throw new Error('No handler registered for /cancel');
      const ack = vi.fn().mockResolvedValue(undefined);
      const respond = vi.fn().mockResolvedValue(undefined);
      await handler({
        ack,
        respond,
        command: { channel_id: 'C0123456789', text },
      });
      return { ack, respond };
    }

    it('registers /cancel command handler', () => {
      new SlackChannel(createTestOpts());
      expect(currentApp().commandHandlers.has('/cancel')).toBe(true);
    });

    it('returns "No task running" when no active container in channel', async () => {
      const mockQueue = {
        getActiveState: vi.fn(() => []),
        forceStopGroup: vi.fn(() => false),
      };
      const { respond } = await fireCommandWithQueue('', mockQueue);
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          response_type: 'ephemeral',
          text: expect.stringContaining('No task running'),
        }),
      );
    });

    it('returns ephemeral ack with group name when container is active', async () => {
      const mockQueue = {
        getActiveState: vi.fn(() => [
          {
            groupJid: 'slack:C0123456789',
            containerName: 'nanoclaw-dev-team-123',
            groupFolder: 'dev-team',
            isTaskContainer: false,
            runningTaskId: null,
          },
        ]),
        forceStopGroup: vi.fn(() => true),
      };
      const { respond } = await fireCommandWithQueue('', mockQueue);
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          response_type: 'ephemeral',
          text: expect.stringContaining('dev-team'),
        }),
      );
      expect(mockQueue.forceStopGroup).toHaveBeenCalledWith(
        'slack:C0123456789',
      );
    });

    it('targets a specific task by ID when taskId argument is provided', async () => {
      const mockQueue = {
        getActiveState: vi.fn(() => [
          {
            groupJid: 'slack:C0000000001',
            containerName: 'nanoclaw-dev-team-111',
            groupFolder: 'dev-team',
            isTaskContainer: true,
            runningTaskId: 'task-abc-123',
          },
          {
            groupJid: 'slack:C0000000002',
            containerName: 'nanoclaw-design-222',
            groupFolder: 'design',
            isTaskContainer: true,
            runningTaskId: 'task-xyz-456',
          },
        ]),
        forceStopGroup: vi.fn(() => true),
      };
      const { respond } = await fireCommandWithQueue('task-abc-123', mockQueue);
      // Should target the task with matching ID, not the invoking channel
      expect(mockQueue.forceStopGroup).toHaveBeenCalledWith(
        'slack:C0000000001',
      );
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ response_type: 'ephemeral' }),
      );
    });

    it('returns "No task running" when taskId not found in active state', async () => {
      const mockQueue = {
        getActiveState: vi.fn(() => [
          {
            groupJid: 'slack:C0000000001',
            containerName: 'nanoclaw-dev-team-111',
            groupFolder: 'dev-team',
            isTaskContainer: true,
            runningTaskId: 'task-abc-123',
          },
        ]),
        forceStopGroup: vi.fn(() => false),
      };
      const { respond } = await fireCommandWithQueue(
        'task-nonexistent',
        mockQueue,
      );
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('No task running'),
        }),
      );
    });

    it('returns error message when queue is not available', async () => {
      const opts = createTestOpts({ queue: undefined });
      new SlackChannel(opts);
      const handler = currentApp().commandHandlers.get('/cancel');
      if (!handler) throw new Error('No /cancel handler');
      const ack = vi.fn().mockResolvedValue(undefined);
      const respond = vi.fn().mockResolvedValue(undefined);
      await handler({
        ack,
        respond,
        command: { channel_id: 'C0123456789', text: '' },
      });
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ response_type: 'ephemeral' }),
      );
    });
  });
});
