import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, _getDb } from './db.js';
import { ContainerOutput } from './container-runner.js';
import { logCostFromOutput } from './cost-logging.js';

beforeEach(() => {
  _initTestDatabase();
});

function makeOutput(overrides: Partial<ContainerOutput> = {}): ContainerOutput {
  return {
    status: 'success',
    result: 'done',
    ...overrides,
  };
}

describe('logCostFromOutput', () => {
  const ctx = {
    groupFolder: 'dispatch',
    chatJid: 'slack:C123',
    runId: '1234567890-test',
  };

  it('prefers computedCostUsd over SDK totalCostUsd', () => {
    const result = logCostFromOutput(
      ctx,
      makeOutput({ totalCostUsd: 0.05, computedCostUsd: 0.08 }),
    );
    expect(result).not.toBeNull();
    expect(result!.effectiveCost).toBe(0.08);
    expect(result!.costSource).toBe('computed');
  });

  it('falls back to SDK totalCostUsd when computedCostUsd is 0', () => {
    const result = logCostFromOutput(
      ctx,
      makeOutput({ totalCostUsd: 0.05, computedCostUsd: 0 }),
    );
    expect(result).not.toBeNull();
    expect(result!.effectiveCost).toBe(0.05);
    expect(result!.costSource).toBe('sdk');
  });

  it('returns null when no cost is present', () => {
    const result = logCostFromOutput(ctx, makeOutput({}));
    expect(result).toBeNull();
  });

  it('returns null when both costs are 0', () => {
    const result = logCostFromOutput(
      ctx,
      makeOutput({ totalCostUsd: 0, computedCostUsd: 0 }),
    );
    expect(result).toBeNull();
  });

  it('persists run_id to cost_log', () => {
    logCostFromOutput(ctx, makeOutput({ computedCostUsd: 0.15 }));

    const db = _getDb();
    const row = db
      .prepare('SELECT * FROM cost_log WHERE run_id = ?')
      .get('1234567890-test') as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.cost_usd).toBeCloseTo(0.15);
    expect(row.cost_source).toBe('computed');
    expect(row.group_folder).toBe('dispatch');
    expect(row.chat_jid).toBe('slack:C123');
  });

  it('persists token breakdown when tokenUsage is present', () => {
    logCostFromOutput(
      ctx,
      makeOutput({
        computedCostUsd: 0.25,
        tokenUsage: {
          inputTokens: 10000,
          outputTokens: 3000,
          cacheCreationInputTokens: 1000,
          cacheReadInputTokens: 5000,
        },
      }),
    );

    const db = _getDb();
    const row = db
      .prepare('SELECT * FROM cost_log WHERE run_id = ?')
      .get('1234567890-test') as Record<string, unknown>;

    expect(row.input_tokens).toBe(10000);
    expect(row.output_tokens).toBe(3000);
    expect(row.cache_creation_tokens).toBe(1000);
    expect(row.cache_read_tokens).toBe(5000);
  });

  it('handles missing tokenUsage gracefully', () => {
    logCostFromOutput(ctx, makeOutput({ totalCostUsd: 0.1 }));

    const db = _getDb();
    const row = db
      .prepare('SELECT * FROM cost_log WHERE run_id = ?')
      .get('1234567890-test') as Record<string, unknown>;

    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
    expect(row.cost_source).toBe('sdk');
  });
});
