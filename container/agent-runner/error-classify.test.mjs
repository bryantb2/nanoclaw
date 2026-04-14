/**
 * Tests for classifyApiError() error classification logic.
 *
 * The actual classifyApiError() is exported from container/agent-runner/src/index.ts
 * which cannot be imported here (depends on @anthropic-ai/claude-agent-sdk).
 * This test replicates the logic verbatim to verify behavior.
 * If the source changes, this replica must be updated too.
 *
 * Critical ordering: rate_limit is checked BEFORE budget to prevent double-matching
 * on strings like "limit exceeded" that appear in both rate-limit and budget contexts.
 */
import { describe, it, expect } from 'vitest';

function classifyApiError(message) {
  const isRateLimitError = /rate.?limit|too many requests|429/i.test(message);
  if (isRateLimitError) return 'rate_limit';

  const isAuthError = /authentication_error|invalid.?api.?key|401\b/i.test(message);
  if (isAuthError) return 'auth';

  const isBudgetError = /budget|credit|billing|payment|quota|limit exceeded|overloaded|529|402/i.test(message);
  if (isBudgetError) return 'budget';

  return 'other';
}

describe('classifyApiError', () => {
  describe('rate limit errors', () => {
    it('classifies "Rate limit exceeded" as rate_limit', () => {
      expect(classifyApiError("Rate limit exceeded")).toBe('rate_limit');
    });

    it('classifies "429 Too Many Requests" as rate_limit', () => {
      expect(classifyApiError("429 Too Many Requests")).toBe('rate_limit');
    });

    it('classifies "rate limit reached for model" as rate_limit', () => {
      expect(classifyApiError("rate limit reached for model")).toBe('rate_limit');
    });

    it('classifies "too many requests" as rate_limit', () => {
      expect(classifyApiError("too many requests")).toBe('rate_limit');
    });
  });

  describe('auth errors', () => {
    it('classifies "authentication_error: invalid api key" as auth', () => {
      expect(classifyApiError("authentication_error: invalid api key")).toBe('auth');
    });

    it('classifies "invalid_api_key" as auth', () => {
      expect(classifyApiError("invalid_api_key")).toBe('auth');
    });

    it('classifies "401 Unauthorized" as auth', () => {
      expect(classifyApiError("401 Unauthorized")).toBe('auth');
    });
  });

  describe('budget errors', () => {
    it('classifies "error_max_budget_usd: budget exceeded" as budget', () => {
      expect(classifyApiError("error_max_budget_usd: budget exceeded")).toBe('budget');
    });

    it('classifies "credit limit exceeded" as budget (NOT rate_limit)', () => {
      // Critical: "limit exceeded" alone must NOT trigger rate_limit.
      // rate_limit regex requires "rate" adjacent to "limit".
      expect(classifyApiError("credit limit exceeded")).toBe('budget');
    });
  });

  describe('other errors', () => {
    it('classifies "Internal server error" as other', () => {
      expect(classifyApiError("Internal server error")).toBe('other');
    });

    it('classifies "unexpected token in JSON" as other', () => {
      expect(classifyApiError("unexpected token in JSON")).toBe('other');
    });
  });

  describe('ordering (rate_limit checked before budget)', () => {
    it('rate_limit check runs before budget — rate limit exceeded returns rate_limit not budget', () => {
      // If budget check ran first, "limit exceeded" in rate limit message could match budget regex.
      // Ensure rate_limit wins.
      expect(classifyApiError("Rate limit exceeded")).toBe('rate_limit');
    });

    it('401 is auth not other', () => {
      expect(classifyApiError("401")).toBe('auth');
    });
  });
});
