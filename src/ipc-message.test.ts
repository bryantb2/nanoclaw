import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  getNewMessages,
  storeMessage,
  setRegisteredGroup,
  storeChatMetadata,
} from './db.js';
import { processMessageIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// --- Group fixtures ---

const DISPATCH_GROUP: RegisteredGroup = {
  name: 'Dispatch',
  folder: 'slack_dispatch',
  trigger: '@Fleet',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const DEV_TEAM_GROUP: RegisteredGroup = {
  name: 'dev-team',
  folder: 'slack_dev-team',
  trigger: '@Fleet',
  added_at: '2024-01-01T00:00:00.000Z',
  requiresTrigger: true,
};

const QA_GROUP: RegisteredGroup = {
  name: 'qa-sentinel',
  folder: 'slack_qa-sentinel',
  trigger: '@Fleet',
  added_at: '2024-01-01T00:00:00.000Z',
  requiresTrigger: true,
};

const NON_MAIN_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'slack_other',
  trigger: '@Fleet',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'slack:dispatch': DISPATCH_GROUP,
    'slack:dev-team': DEV_TEAM_GROUP,
    'slack:qa-sentinel': QA_GROUP,
    'slack:other': NON_MAIN_GROUP,
  };

  setRegisteredGroup('slack:dispatch', DISPATCH_GROUP);
  setRegisteredGroup('slack:dev-team', DEV_TEAM_GROUP);
  setRegisteredGroup('slack:qa-sentinel', QA_GROUP);
  setRegisteredGroup('slack:other', NON_MAIN_GROUP);

  // Initialize chat metadata so getNewMessages can find messages
  storeChatMetadata('slack:dev-team', '2024-01-01T00:00:00.000Z');
  storeChatMetadata('slack:qa-sentinel', '2024-01-01T00:00:00.000Z');
});

// --- processMessageIpc ---

describe('processMessageIpc', () => {
  describe('authorization', () => {
    it('main group (dispatch) can send to any group', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const injectMessage = vi.fn();

      const result = await processMessageIpc(
        {
          type: 'message',
          chatJid: 'slack:dev-team',
          text: '@Fleet [DISPATCH-ROUTED] implement KRE-227',
        },
        'slack_dispatch',
        true, // isMain
        groups,
        { sendMessage, injectMessage },
      );

      expect(result).toBe('sent');
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(injectMessage).toHaveBeenCalledOnce();
    });

    it('non-main group cannot send to a different group', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const injectMessage = vi.fn();

      const result = await processMessageIpc(
        {
          type: 'message',
          chatJid: 'slack:dev-team',
          text: 'unauthorized cross-group message',
        },
        'slack_other',
        false, // not isMain
        groups,
        { sendMessage, injectMessage },
      );

      expect(result).toBe('unauthorized');
      expect(sendMessage).not.toHaveBeenCalled();
      expect(injectMessage).not.toHaveBeenCalled();
    });

    it('non-main group can send to its own channel', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const injectMessage = vi.fn();

      const result = await processMessageIpc(
        {
          type: 'message',
          chatJid: 'slack:other',
          text: '@Fleet self-message',
        },
        'slack_other',
        false,
        groups,
        { sendMessage, injectMessage },
      );

      expect(result).toBe('sent');
      expect(sendMessage).toHaveBeenCalledOnce();
    });
  });

  describe('message injection', () => {
    it('calls injectMessage with correct args after sendMessage', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const injectMessage = vi.fn();

      await processMessageIpc(
        {
          type: 'message',
          chatJid: 'slack:dev-team',
          text: '@Fleet [DISPATCH-ROUTED] build feature X',
        },
        'slack_dispatch',
        true,
        groups,
        { sendMessage, injectMessage },
      );

      expect(injectMessage).toHaveBeenCalledWith(
        'slack:dev-team',
        '@Fleet [DISPATCH-ROUTED] build feature X',
        'ipc:slack_dispatch',
      );
    });

    it('works when injectMessage is undefined (backwards compat)', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);

      const result = await processMessageIpc(
        {
          type: 'message',
          chatJid: 'slack:dev-team',
          text: '@Fleet some task',
        },
        'slack_dispatch',
        true,
        groups,
        { sendMessage }, // no injectMessage
      );

      expect(result).toBe('sent');
      expect(sendMessage).toHaveBeenCalledOnce();
    });

    it('passes threadTs to sendMessage when present', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);

      await processMessageIpc(
        {
          type: 'message',
          chatJid: 'slack:dev-team',
          text: '@Fleet reply in thread',
          threadTs: '1234567890.123456',
        },
        'slack_dispatch',
        true,
        groups,
        { sendMessage },
      );

      expect(sendMessage).toHaveBeenCalledWith(
        'slack:dev-team',
        '@Fleet reply in thread',
        { threadTs: '1234567890.123456' },
      );
    });
  });

  describe('skipped messages', () => {
    it('skips non-message types', async () => {
      const sendMessage = vi.fn();
      const injectMessage = vi.fn();

      const result = await processMessageIpc(
        { type: 'uploadFile', chatJid: 'slack:dev-team', text: 'hi' },
        'slack_dispatch',
        true,
        groups,
        { sendMessage, injectMessage },
      );

      expect(result).toBe('skipped');
      expect(sendMessage).not.toHaveBeenCalled();
      expect(injectMessage).not.toHaveBeenCalled();
    });

    it('skips messages with missing chatJid', async () => {
      const sendMessage = vi.fn();

      const result = await processMessageIpc(
        { type: 'message', text: 'no target' },
        'slack_dispatch',
        true,
        groups,
        { sendMessage },
      );

      expect(result).toBe('skipped');
    });

    it('skips messages with missing text', async () => {
      const sendMessage = vi.fn();

      const result = await processMessageIpc(
        { type: 'message', chatJid: 'slack:dev-team' },
        'slack_dispatch',
        true,
        groups,
        { sendMessage },
      );

      expect(result).toBe('skipped');
    });
  });
});

// --- Integration: injected messages are visible to getNewMessages ---

describe('IPC injection integration with DB', () => {
  it('bot messages (is_bot_message=true) are invisible to getNewMessages', () => {
    // This proves the bug: bot-posted Slack messages are filtered out
    storeMessage({
      id: 'bot-msg-1',
      chat_jid: 'slack:dev-team',
      sender: 'bot',
      sender_name: 'Agent Fleet',
      content: '@Fleet [DISPATCH-ROUTED] implement something',
      timestamp: '1700000001',
      is_from_me: true,
      is_bot_message: true,
    });

    const { messages } = getNewMessages(
      ['slack:dev-team'],
      '1700000000',
      'Fleet',
    );

    expect(messages).toHaveLength(0);
  });

  it('injected messages (is_bot_message=false) ARE visible to getNewMessages', () => {
    // This proves the fix: injected messages bypass the bot filter
    storeMessage({
      id: 'ipc-1700000001',
      chat_jid: 'slack:dev-team',
      sender: 'ipc',
      sender_name: 'ipc:slack_dispatch',
      content: '@Fleet [DISPATCH-ROUTED] implement something',
      timestamp: '1700000001',
      is_from_me: true,
      is_bot_message: false,
    });

    const { messages } = getNewMessages(
      ['slack:dev-team'],
      '1700000000',
      'Fleet',
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe(
      '@Fleet [DISPATCH-ROUTED] implement something',
    );
    expect(messages[0].is_from_me).toBeTruthy();
  });

  it('injected message with is_from_me=true passes trigger sender check', () => {
    // The trigger check is: TRIGGER_PATTERN.test(content) && (is_from_me || allowlist)
    // is_from_me=true means no allowlist lookup needed for sender 'ipc'
    storeMessage({
      id: 'ipc-1700000002',
      chat_jid: 'slack:dev-team',
      sender: 'ipc',
      sender_name: 'ipc:slack_dispatch',
      content: '@Fleet [DISPATCH-ROUTED] build KRE-227',
      timestamp: '1700000002',
      is_from_me: true,
      is_bot_message: false,
    });

    const { messages } = getNewMessages(
      ['slack:dev-team'],
      '1700000000',
      'Fleet',
    );

    expect(messages).toHaveLength(1);
    // Verify the fields that the trigger check uses
    const msg = messages[0];
    expect(msg.is_from_me).toBeTruthy();
    // Content starts with @Fleet — matches TRIGGER_PATTERN /^@Fleet\b/i
    expect(msg.content.startsWith('@Fleet')).toBe(true);
  });

  it('multiple injected messages from different sources are all visible', () => {
    storeMessage({
      id: 'ipc-1700000001',
      chat_jid: 'slack:dev-team',
      sender: 'ipc',
      sender_name: 'ipc:slack_dispatch',
      content: '@Fleet [DISPATCH-ROUTED] task 1',
      timestamp: '1700000001',
      is_from_me: true,
      is_bot_message: false,
    });

    storeMessage({
      id: 'ipc-1700000002',
      chat_jid: 'slack:qa-sentinel',
      sender: 'ipc',
      sender_name: 'ipc:slack_dispatch',
      content: '@Fleet [DISPATCH-ROUTED] QA gate for PR #100',
      timestamp: '1700000002',
      is_from_me: true,
      is_bot_message: false,
    });

    const devTeam = getNewMessages(
      ['slack:dev-team'],
      '1700000000',
      'Fleet',
    );
    const qa = getNewMessages(
      ['slack:qa-sentinel'],
      '1700000000',
      'Fleet',
    );

    expect(devTeam.messages).toHaveLength(1);
    expect(qa.messages).toHaveLength(1);
  });
});
