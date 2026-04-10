export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  max_budget_usd?: number | null;
  /** When true, container stdout is NOT auto-posted to Slack.
   *  Agent uses IPC sendMessage for deliberate communication only. */
  suppress_output?: boolean;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
  run_id?: string;
}

// --- Completion record schema ---

/** Completion record written by every agent loop to /workspace/output/latest.json */
export interface CompletionRecord {
  schema_version: '1.0';
  agent: string;
  task_id: string;
  status: 'success' | 'error' | 'budget_exceeded' | 'timeout';
  timestamp: string;
  duration_ms: number;
  cost_usd: number;
  inputs: Record<string, unknown>;
  outputs: CompletionOutput[];
  audit_entry: string;
  blockers: string[];
  cross_loop_signals: CrossLoopSignal[];
}

export interface CompletionOutput {
  type:
    | 'slack_message'
    | 'github_pr'
    | 'linear_ticket'
    | 'drive_doc'
    | 'file'
    | 'other';
  description: string;
  url?: string;
  artifact_id?: string;
}

export interface CrossLoopSignal {
  signal_type: string;
  payload: Record<string, unknown>;
  target_group?: string;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  /**
   * Send a message. Returns the platform-native message identifier on
   * success (Slack: the `ts` returned by chat.postMessage — usable as
   * `thread_ts` for subsequent replies). Returns `undefined` when the
   * message could not be sent and was queued/dropped, or when the
   * channel has no meaningful identifier for the IPC threading path.
   *
   * Option B (IPC threading) relies on this return value to anchor
   * dispatch-routed replies to real Slack timestamps instead of
   * synthetic `ipc-` IDs.
   */
  sendMessage(
    jid: string,
    text: string,
    opts?: { threadTs?: string },
  ): Promise<string | undefined>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: add an emoji reaction to an inbound message.
  reactToMessage?(
    channelId: string,
    messageTs: string,
    emoji: string,
  ): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: upload a file to a channel.
  uploadFile?(params: {
    channelId: string;
    filePath: string;
    threadTs?: string;
    title?: string;
    comment?: string;
  }): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
