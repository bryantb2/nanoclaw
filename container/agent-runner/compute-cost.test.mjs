/**
 * Tests for computeCostFromTokens() pricing logic.
 *
 * The actual computeCostFromTokens() is inside container/agent-runner/src/index.ts
 * which cannot be imported here (depends on @anthropic-ai/claude-agent-sdk).
 * This test replicates the logic verbatim to verify the math and model fallback.
 * If the source changes, this replica must be updated too.
 */
import { describe, it, expect } from 'vitest';

const OPUS_PRICING = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.50 };
const SONNET_PRICING = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 };
const HAIKU_PRICING = { input: 0.80, output: 4, cacheWrite: 1.00, cacheRead: 0.08 };

const MODEL_PRICING = {
  'claude-opus-4-6-20250514':        OPUS_PRICING,
  'claude-opus-4-6':                 OPUS_PRICING,
  'claude-opus-4-20250514':          OPUS_PRICING,
  'claude-opus-4-0':                 OPUS_PRICING,
  'claude-sonnet-4-6-20250514':      SONNET_PRICING,
  'claude-sonnet-4-6':               SONNET_PRICING,
  'claude-sonnet-4-20250514':        SONNET_PRICING,
  'claude-sonnet-4-0':               SONNET_PRICING,
  'claude-3-5-sonnet-20241022':      SONNET_PRICING,
  'claude-3-5-haiku-20241022':       HAIKU_PRICING,
};

const DEFAULT_PRICING = SONNET_PRICING;

function computeCostFromTokens(usage, model) {
  let pricing = DEFAULT_PRICING;
  if (model) {
    const exact = MODEL_PRICING[model];
    if (exact) {
      pricing = exact;
    } else {
      const prefix = model.includes('opus') ? OPUS_PRICING
        : model.includes('haiku') ? HAIKU_PRICING
        : model.includes('sonnet') ? SONNET_PRICING
        : null;
      if (prefix) {
        pricing = prefix;
      }
    }
  }
  return (
    (usage.inputTokens * pricing.input / 1_000_000) +
    (usage.outputTokens * pricing.output / 1_000_000) +
    (usage.cacheCreationInputTokens * pricing.cacheWrite / 1_000_000) +
    (usage.cacheReadInputTokens * pricing.cacheRead / 1_000_000)
  );
}

describe('computeCostFromTokens', () => {
  const zeros = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  describe('Sonnet pricing (default)', () => {
    it('computes cost for 1M input tokens at $3', () => {
      const cost = computeCostFromTokens(
        { ...zeros, inputTokens: 1_000_000 },
        'claude-sonnet-4-0',
      );
      expect(cost).toBeCloseTo(3.0);
    });

    it('computes cost for 1M output tokens at $15', () => {
      const cost = computeCostFromTokens(
        { ...zeros, outputTokens: 1_000_000 },
        'claude-sonnet-4-0',
      );
      expect(cost).toBeCloseTo(15.0);
    });

    it('computes cost for mixed token usage', () => {
      const cost = computeCostFromTokens(
        {
          inputTokens: 10_000,
          outputTokens: 2_000,
          cacheCreationInputTokens: 1_000,
          cacheReadInputTokens: 5_000,
        },
        'claude-sonnet-4-0',
      );
      // 10000 * 3/1M = 0.03
      // 2000 * 15/1M = 0.03
      // 1000 * 3.75/1M = 0.00375
      // 5000 * 0.30/1M = 0.0015
      // Total: 0.06525
      expect(cost).toBeCloseTo(0.06525, 5);
    });
  });

  describe('Opus pricing', () => {
    it('computes cost for 1M input tokens at $15 (5x Sonnet)', () => {
      const cost = computeCostFromTokens(
        { ...zeros, inputTokens: 1_000_000 },
        'claude-opus-4-0',
      );
      expect(cost).toBeCloseTo(15.0);
    });

    it('computes cost for 1M output tokens at $75', () => {
      const cost = computeCostFromTokens(
        { ...zeros, outputTokens: 1_000_000 },
        'claude-opus-4-0',
      );
      expect(cost).toBeCloseTo(75.0);
    });
  });

  describe('Haiku pricing', () => {
    it('computes cost for 1M input tokens at $0.80', () => {
      const cost = computeCostFromTokens(
        { ...zeros, inputTokens: 1_000_000 },
        'claude-3-5-haiku-20241022',
      );
      expect(cost).toBeCloseTo(0.80);
    });
  });

  describe('cache pricing', () => {
    it('charges cache_write at higher rate than input', () => {
      const cost = computeCostFromTokens(
        { ...zeros, cacheCreationInputTokens: 1_000_000 },
        'claude-sonnet-4-0',
      );
      expect(cost).toBeCloseTo(3.75);
    });

    it('charges cache_read at 10% of input rate for Sonnet', () => {
      const cost = computeCostFromTokens(
        { ...zeros, cacheReadInputTokens: 1_000_000 },
        'claude-sonnet-4-0',
      );
      expect(cost).toBeCloseTo(0.30);
    });
  });

  describe('model fallback', () => {
    it('uses Sonnet pricing by default when no model is given', () => {
      const cost = computeCostFromTokens(
        { ...zeros, inputTokens: 1_000_000 },
        undefined,
      );
      expect(cost).toBeCloseTo(3.0); // Sonnet rate
    });

    it('uses prefix matching for unknown opus variant', () => {
      const cost = computeCostFromTokens(
        { ...zeros, inputTokens: 1_000_000 },
        'claude-opus-4-7-20260101',
      );
      expect(cost).toBeCloseTo(15.0); // Opus rate
    });

    it('uses prefix matching for unknown sonnet variant', () => {
      const cost = computeCostFromTokens(
        { ...zeros, inputTokens: 1_000_000 },
        'claude-sonnet-5-20270101',
      );
      expect(cost).toBeCloseTo(3.0); // Sonnet rate
    });

    it('uses prefix matching for unknown haiku variant', () => {
      const cost = computeCostFromTokens(
        { ...zeros, inputTokens: 1_000_000 },
        'claude-haiku-4-20260101',
      );
      expect(cost).toBeCloseTo(0.80); // Haiku rate
    });

    it('falls back to Sonnet for unrelated model name', () => {
      const cost = computeCostFromTokens(
        { ...zeros, inputTokens: 1_000_000 },
        'some-other-model',
      );
      expect(cost).toBeCloseTo(3.0); // Sonnet default
    });
  });

  describe('edge cases', () => {
    it('returns 0 for zero tokens', () => {
      expect(computeCostFromTokens(zeros, 'claude-sonnet-4-0')).toBe(0);
    });

    it('handles realistic dispatch run (short Linear check)', () => {
      // Realistic dispatch-build-loop run: load CLAUDE.md context (~8K tokens),
      // small prompt, small response, mostly cache reads
      const cost = computeCostFromTokens(
        {
          inputTokens: 2_000,
          outputTokens: 500,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 6_000,
        },
        'claude-sonnet-4-0',
      );
      // 2000 * 3/1M = 0.006
      // 500 * 15/1M = 0.0075
      // 6000 * 0.30/1M = 0.0018
      // Total: 0.0153
      expect(cost).toBeCloseTo(0.0153, 5);
    });

    it('handles realistic QA sentinel run (multiple PRs)', () => {
      // QA sentinel doing real work: larger context, more tool use
      const cost = computeCostFromTokens(
        {
          inputTokens: 150_000,
          outputTokens: 20_000,
          cacheCreationInputTokens: 5_000,
          cacheReadInputTokens: 100_000,
        },
        'claude-sonnet-4-0',
      );
      // 150000 * 3/1M = 0.45
      // 20000 * 15/1M = 0.30
      // 5000 * 3.75/1M = 0.01875
      // 100000 * 0.30/1M = 0.03
      // Total: 0.79875
      expect(cost).toBeCloseTo(0.79875, 4);
    });
  });
});
