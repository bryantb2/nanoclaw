/**
 * Shared cost logging helper used by both runAgent (human-triggered)
 * and runTask (scheduled tasks) to avoid duplicating cost logic.
 */
import { ContainerOutput } from './container-runner.js';
import { appendCostLog, getCostSummary } from './db.js';
import { logger } from './logger.js';

export interface CostLoggingContext {
  groupFolder: string;
  chatJid: string;
  runId: string;
}

/**
 * Log cost from a container execution. Picks the best available cost
 * source (computed > SDK), writes to cost_log, and returns the summary.
 */
export function logCostFromOutput(
  ctx: CostLoggingContext,
  output: ContainerOutput,
): { effectiveCost: number; costSource: 'computed' | 'sdk' | 'ipc' } | null {
  const effectiveCost =
    (output.computedCostUsd ?? 0) > 0
      ? output.computedCostUsd!
      : (output.totalCostUsd ?? 0);
  const costSource =
    (output.computedCostUsd ?? 0) > 0
      ? ('computed' as const)
      : (output.totalCostUsd ?? 0) > 0
        ? ('sdk' as const)
        : ('ipc' as const);

  logger.debug(
    {
      group: ctx.groupFolder,
      sdkCost: output.totalCostUsd ?? null,
      computedCost: output.computedCostUsd ?? null,
      effectiveCost,
      costSource,
    },
    'Agent run cost data',
  );

  if (effectiveCost <= 0) return null;

  try {
    appendCostLog(ctx.groupFolder, ctx.chatJid, effectiveCost, {
      runId: ctx.runId,
      inputTokens: output.tokenUsage?.inputTokens,
      outputTokens: output.tokenUsage?.outputTokens,
      cacheCreationTokens: output.tokenUsage?.cacheCreationInputTokens,
      cacheReadTokens: output.tokenUsage?.cacheReadInputTokens,
      costSource,
    });
    return { effectiveCost, costSource };
  } catch (err) {
    logger.warn({ group: ctx.groupFolder, err }, 'Failed to log cost');
    return null;
  }
}

/**
 * Write cost summary JSON file to the group directory.
 */
export function writeCostSummaryFile(
  groupFolder: string,
  groupDir: string,
  fs: typeof import('fs'),
  path: typeof import('path'),
): void {
  try {
    const summary = getCostSummary(groupFolder);
    const costSummaryPath = path.join(groupDir, 'cost-summary.json');
    fs.writeFileSync(
      costSummaryPath,
      JSON.stringify(
        {
          today_usd: summary.todayUsd,
          week_usd: summary.weekUsd,
          all_time_usd: summary.allTimeUsd,
          last_updated: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    logger.warn({ group: groupFolder, err }, 'Failed to write cost summary');
  }
}
