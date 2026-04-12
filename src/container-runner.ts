/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { deleteInFlightTask, insertInFlightTask } from './db.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { OneCLI } from '@onecli-sh/sdk';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL });

const GITHUB_APP_ID = '3043813';

interface IpcCostData {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * Read cost data from the IPC cost file written by the agent-runner.
 * Used to recover cost when containers are killed (timeout, OOM, budget cap).
 */
function readIpcCostFile(groupFolder: string): IpcCostData | null {
  try {
    const ipcDir = resolveGroupIpcPath(groupFolder);
    const costFile = path.join(ipcDir, 'cost.json');
    const data = JSON.parse(fs.readFileSync(costFile, 'utf-8'));
    fs.unlinkSync(costFile);
    return data as IpcCostData;
  } catch {
    return null;
  }
}

/** Recover cost from IPC file when no cost was accumulated from output markers. */
function recoverIpcCost(groupFolder: string): {
  costUsd: number;
  tokenUsage?: TokenUsage;
} {
  const ipcCost = readIpcCostFile(groupFolder);
  return bestCost(0, 0, ipcCost);
}

/** Pick the best available cost: prefer computed (from tokens), fall back to SDK, then IPC recovery. */
function bestCost(
  accumulatedSdk: number,
  accumulatedComputed: number,
  ipcCost: IpcCostData | null,
): { costUsd: number; tokenUsage?: TokenUsage } {
  if (accumulatedComputed > 0) {
    return { costUsd: accumulatedComputed };
  }
  if (accumulatedSdk > 0) {
    return { costUsd: accumulatedSdk };
  }
  if (ipcCost && ipcCost.costUsd > 0) {
    return {
      costUsd: ipcCost.costUsd,
      tokenUsage: {
        inputTokens: ipcCost.inputTokens,
        outputTokens: ipcCost.outputTokens,
        cacheCreationInputTokens: ipcCost.cacheCreationInputTokens,
        cacheReadInputTokens: ipcCost.cacheReadInputTokens,
      },
    };
  }
  return { costUsd: 0 };
}

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  maxBudgetUsd?: number;
  threadTs?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  totalCostUsd?: number;
  /** Cost computed from token counts using Anthropic pricing (more reliable than SDK totalCostUsd) */
  computedCostUsd?: number;
  /** Token-level usage breakdown */
  tokenUsage?: TokenUsage;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Refresh a group's agent-runner source cache from the upstream source.
 *
 * The per-group cache exists because of security fix #392 (commit 5fb10645):
 * the project root is mounted read-only to prevent sandbox escape, so each
 * group needs its own writable copy of the agent-runner source. The
 * container's entrypoint recompiles `/app/src` (this cache) to `/tmp/dist`
 * on every spawn and runs from there — `/app/dist` from the image build is
 * never executed, only this cache is.
 *
 * This MUST run on every container spawn. The previous implementation used
 * `if (!fs.existsSync(groupAgentRunnerDir)) cpSync(...)` which made the cache
 * write-once: once a group spawned its first container, every subsequent
 * agent-runner change was silently swallowed for that group, even after
 * `restart-fleet.sh` and submodule bumps. PR #29 (token-based cost tracking)
 * shipped to the host on Apr 9 but never reached cached groups, which is
 * why dispatch / dev-team / qa-sentinel / fleet-ops continued reporting
 * `cost_source='sdk'` with 0 tokens for two days.
 *
 * Wipe-and-recopy is safe: the cache contains only TypeScript source files,
 * no per-group customizations or session state lives inside the cache dir,
 * and there are no external references to files inside it. Per-group
 * isolation is preserved because each group still gets an independent
 * writable copy at a distinct path (`groupAgentRunnerDir` is per-group).
 *
 * **Atomic rename pattern.** Naive `rmSync(dest); cpSync(src, dest)` would
 * leave a partial cache on disk if `cpSync` fails midway (disk full, EIO,
 * permission revocation), and the next container's `tsc` step would crash
 * on the broken source tree. Instead we copy to a sibling `dest + '.new'`
 * scratch dir first, then swap: if the cp fails, the existing cache is
 * intact and the next spawn retries cleanly. The final swap is rmSync(dest)
 * + renameSync(.new, dest); if the host dies between the two, the next
 * spawn finds no dest, cleans the leftover .new, and recopies fresh.
 *
 * @internal — exported only for tests; production callers go through
 * `buildVolumeMounts`.
 */
export function refreshAgentRunnerSrcCache(
  agentRunnerSrc: string,
  groupAgentRunnerDir: string,
): void {
  if (!fs.existsSync(agentRunnerSrc)) return;
  const scratchDir = `${groupAgentRunnerDir}.new`;
  try {
    // Clean up any leftover scratch dir from a prior failed/aborted refresh.
    // `force: true` makes this a no-op if the path doesn't exist (the common
    // case) and tolerates concurrent operator/backup deletion.
    fs.rmSync(scratchDir, { recursive: true, force: true });
    // Copy to scratch first. If this throws (disk full, EIO), the existing
    // cache at groupAgentRunnerDir is untouched — failure is isolated.
    fs.cpSync(agentRunnerSrc, scratchDir, { recursive: true });
    // Atomic-ish swap: drop the old cache then rename scratch into place.
    // The window where dest is missing is sub-millisecond and protected by
    // GroupQueue.active serialization (only one spawn per group at a time).
    fs.rmSync(groupAgentRunnerDir, { recursive: true, force: true });
    fs.renameSync(scratchDir, groupAgentRunnerDir);
    logger.debug(
      { groupAgentRunnerDir },
      'Refreshed agent-runner src cache',
    );
  } catch (err) {
    // Best-effort scratch cleanup so a partial copy doesn't accumulate
    // across retries. Real failure is propagated to the caller (which
    // owns the spawn lifecycle and can decide whether to fail or retry).
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* ignore secondary cleanup failure */
    }
    logger.error(
      { agentRunnerSrc, groupAgentRunnerDir, err },
      'Failed to refresh agent-runner src cache',
    );
    throw err;
  }
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the OneCLI gateway, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Per-group writable copy of agent-runner source. Required by security
  // fix #392 (commit 5fb10645) which mounted the project root read-only
  // to prevent sandbox escape — each group needs its own writable copy at
  // a distinct path so cross-group code mutation is impossible.
  //
  // The cache is REFRESHED on every spawn (not persistent across spawns)
  // so upstream agent-runner changes actually deploy. See the helper's
  // docstring above for the full incident history and atomic-rename
  // rationale. Do NOT write runtime state into this dir — it gets wiped
  // on the next container spawn.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  refreshAgentRunnerSrcCache(agentRunnerSrc, groupAgentRunnerDir);
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Output directory: writable by container, readable by host IPC for file uploads
  const outputDir = path.join(DATA_DIR, group.folder, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  mounts.push({
    hostPath: outputDir,
    containerPath: '/workspace/output',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentIdentifier?: string,
  extraEnv: Record<string, string> = {},
): Promise<string[]> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Memory and CPU limits per container
  args.push('--memory=3g', '--memory-swap=3g');
  args.push('--cpus=2');

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // OneCLI gateway handles credential injection — containers never see real secrets.
  // The gateway intercepts HTTPS traffic and injects API keys or OAuth tokens.
  const onecliApplied = await onecli.applyContainerConfig(args, {
    addHostMapping: false, // Nanoclaw already handles host gateway
    agent: agentIdentifier,
  });
  if (onecliApplied) {
    logger.info({ containerName }, 'OneCLI gateway config applied');
  } else {
    logger.warn(
      { containerName },
      'OneCLI gateway not reachable — container will have no credentials',
    );
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Pass through credential env vars
  for (const [key, value] of Object.entries(extraEnv)) {
    args.push('-e', `${key}=${value}`);
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (
    proc: ChildProcess,
    containerName: string,
    resetTimeout: () => void,
  ) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');

  // Build credential env vars for pass-through
  const extraEnv: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY)
    extraEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.LINEAR_API_KEY)
    extraEnv.LINEAR_API_KEY = process.env.LINEAR_API_KEY;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    extraEnv.GOOGLE_SERVICE_ACCOUNT_JSON =
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  // Pass GitHub App credentials so the container can generate fresh
  // installation tokens on demand (tokens expire after 1 hour).
  if (process.env.GITHUB_APP_PRIVATE_KEY) {
    extraEnv.GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;
    extraEnv.GITHUB_APP_ID = GITHUB_APP_ID;
  }

  const containerArgs = await buildContainerArgs(
    mounts,
    containerName,
    agentIdentifier,
    extraEnv,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Track this container so interrupted tasks can be detected on restart
  const channelId = input.chatJid.replace(/^[^:]+:/, '');
  let inFlightId: number | undefined;
  try {
    inFlightId = insertInFlightTask({
      group_folder: input.groupFolder,
      channel_id: channelId,
      thread_ts: input.threadTs ?? null,
      original_message: input.prompt.slice(0, 1000),
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to insert in_flight_task');
  }

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Mutable reference to the timeout reset function, assigned once the
    // timeout is created below.  Exposed to the host via onProcess so that
    // the group queue can reset the hard timeout when new IPC work is piped.
    let resetTimeoutFn: (() => void) | undefined;
    onProcess(container, containerName, () => resetTimeoutFn?.());

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            if (parsed.totalCostUsd && parsed.totalCostUsd > 0) {
              // SDK total_cost_usd is cumulative within a query() call.
              // Agent teams may produce multiple results per call, each
              // carrying the running total. Track the max per query.
              currentQueryMaxCost = Math.max(
                currentQueryMaxCost,
                parsed.totalCostUsd,
              );
            }
            // Track computed cost (from token counts) — same cumulative logic
            if (parsed.computedCostUsd && parsed.computedCostUsd > 0) {
              currentQueryMaxComputedCost = Math.max(
                currentQueryMaxComputedCost,
                parsed.computedCostUsd,
              );
            }
            if (parsed.tokenUsage) {
              lastTokenUsage = parsed.tokenUsage;
            }
            // Session-update marker (null result, no cost) = query() boundary.
            // Flush the current query's cost and reset for the next query.
            if (parsed.result === null && !parsed.totalCostUsd) {
              accumulatedCostUsd += currentQueryMaxCost;
              currentQueryMaxCost = 0;
              accumulatedComputedCost += currentQueryMaxComputedCost;
              currentQueryMaxComputedCost = 0;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    let accumulatedCostUsd = 0;
    let currentQueryMaxCost = 0;
    // Track computed cost (from token counts) separately — more reliable than SDK totalCostUsd
    let accumulatedComputedCost = 0;
    let currentQueryMaxComputedCost = 0;
    let lastTokenUsage: TokenUsage | undefined;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output or IPC message)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };
    // Expose to the host-side wrapper created above
    resetTimeoutFn = resetTimeout;

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            if (inFlightId !== undefined) {
              try {
                deleteInFlightTask(inFlightId);
              } catch {}
            }
            // Flush any remaining query cost before resolving
            accumulatedCostUsd += currentQueryMaxCost;
            currentQueryMaxCost = 0;
            accumulatedComputedCost += currentQueryMaxComputedCost;
            currentQueryMaxComputedCost = 0;
            // Clean up stale IPC cost file from this run
            readIpcCostFile(group.folder);
            const cost = bestCost(
              accumulatedCostUsd,
              accumulatedComputedCost,
              null,
            );
            resolve({
              status: 'success',
              result: null,
              newSessionId,
              totalCostUsd: cost.costUsd > 0 ? cost.costUsd : undefined,
              computedCostUsd:
                accumulatedComputedCost > 0
                  ? accumulatedComputedCost
                  : undefined,
              tokenUsage: lastTokenUsage,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        const recovered = recoverIpcCost(group.folder);
        if (recovered.costUsd > 0) {
          logger.info(
            { group: group.name, recoveredCost: recovered.costUsd },
            'Recovered cost from IPC file after timeout',
          );
        }

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
          totalCostUsd: recovered.costUsd > 0 ? recovered.costUsd : undefined,
          computedCostUsd:
            recovered.costUsd > 0 ? recovered.costUsd : undefined,
          tokenUsage: recovered.tokenUsage,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        // Scrub credentials from container args before logging
        const scrubbed = containerArgs.map((arg, i) => {
          const prev = containerArgs[i - 1];
          if (
            prev === '-e' &&
            /^(ANTHROPIC_API_KEY|LINEAR_API_KEY|GOOGLE_SERVICE_ACCOUNT_JSON|GITHUB_APP_PRIVATE_KEY)=/.test(
              arg,
            )
          ) {
            return arg.replace(/=.*/, '=[REDACTED]');
          }
          return arg;
        });
        logLines.push(
          `=== Container Args ===`,
          scrubbed.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        // Flush remaining query cost even on error — API tokens were still consumed
        accumulatedCostUsd += currentQueryMaxCost;
        currentQueryMaxCost = 0;
        accumulatedComputedCost += currentQueryMaxComputedCost;
        currentQueryMaxComputedCost = 0;
        // Try IPC recovery if no cost was accumulated from output markers
        const ipcCostOnError =
          accumulatedCostUsd === 0 && accumulatedComputedCost === 0
            ? readIpcCostFile(group.folder)
            : null;
        const errorCost = bestCost(
          accumulatedCostUsd,
          accumulatedComputedCost,
          ipcCostOnError,
        );
        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
          totalCostUsd: errorCost.costUsd > 0 ? errorCost.costUsd : undefined,
          computedCostUsd:
            errorCost.costUsd > 0 ? errorCost.costUsd : undefined,
          tokenUsage: lastTokenUsage ?? errorCost.tokenUsage,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          if (inFlightId !== undefined) {
            try {
              deleteInFlightTask(inFlightId);
            } catch {}
          }
          // Flush any remaining query cost before resolving
          accumulatedCostUsd += currentQueryMaxCost;
          currentQueryMaxCost = 0;
          accumulatedComputedCost += currentQueryMaxComputedCost;
          currentQueryMaxComputedCost = 0;
          // Clean up stale IPC cost file from this run
          readIpcCostFile(group.folder);
          const successCost = bestCost(
            accumulatedCostUsd,
            accumulatedComputedCost,
            null,
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
            totalCostUsd:
              successCost.costUsd > 0 ? successCost.costUsd : undefined,
            computedCostUsd:
              accumulatedComputedCost > 0 ? accumulatedComputedCost : undefined,
            tokenUsage: lastTokenUsage,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        if (inFlightId !== undefined) {
          try {
            deleteInFlightTask(inFlightId);
          } catch {}
        }
        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        const parseCost = recoverIpcCost(group.folder);
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
          totalCostUsd: parseCost.costUsd > 0 ? parseCost.costUsd : undefined,
          computedCostUsd:
            parseCost.costUsd > 0 ? parseCost.costUsd : undefined,
          tokenUsage: parseCost.tokenUsage,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      const spawnCost = recoverIpcCost(group.folder);
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
        totalCostUsd: spawnCost.costUsd > 0 ? spawnCost.costUsd : undefined,
        computedCostUsd: spawnCost.costUsd > 0 ? spawnCost.costUsd : undefined,
        tokenUsage: spawnCost.tokenUsage,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
