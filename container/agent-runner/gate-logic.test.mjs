/**
 * Tests for isSubstantiveApproach() gate logic.
 *
 * The actual isSubstantiveApproach() is exported from container/agent-runner/src/index.ts
 * which cannot be imported here (depends on @anthropic-ai/claude-agent-sdk).
 * This test replicates the logic verbatim to verify behavior.
 * If the source changes, this replica must be updated too.
 */
import { describe, it, expect } from 'vitest';

export const APPROACH_BLOCKLIST = ["on it", "confirmed", "working on this", "acknowledged", "queued"];

export function isSubstantiveApproach(text) {
  if (text.length <= 100) return false;
  const lower = text.toLowerCase();
  return !APPROACH_BLOCKLIST.some(phrase => lower.includes(phrase));
}

describe('isSubstantiveApproach', () => {
  describe('length check', () => {
    it('returns false for short text (under 100 chars)', () => {
      expect(isSubstantiveApproach("short")).toBe(false);
    });

    it('returns false for text exactly 100 chars', () => {
      const text = "a".repeat(100);
      expect(isSubstantiveApproach(text)).toBe(false);
    });

    it('returns true for text over 100 chars with no blocklist match', () => {
      const text = "a]".repeat(51); // 102 chars, no blocklist phrase
      expect(isSubstantiveApproach(text)).toBe(true);
    });
  });

  describe('blocklist phrases', () => {
    it('returns false when text contains "on it" (blocklist)', () => {
      const text = "On it, I'll handle this task for you " + "x".repeat(80);
      expect(isSubstantiveApproach(text)).toBe(false);
    });

    it('returns false when text contains "confirmed" (blocklist)', () => {
      const text = "Confirmed — here is my detailed plan " + "x".repeat(80);
      expect(isSubstantiveApproach(text)).toBe(false);
    });

    it('returns false when text contains "working on this" (blocklist)', () => {
      const text = "Working on this and here is the approach " + "x".repeat(80);
      expect(isSubstantiveApproach(text)).toBe(false);
    });

    it('returns false when text contains "acknowledged" (blocklist)', () => {
      const text = "Acknowledged the request and planning " + "x".repeat(80);
      expect(isSubstantiveApproach(text)).toBe(false);
    });

    it('returns false when text contains "queued" (blocklist)', () => {
      const text = "Queued up the work for processing now " + "x".repeat(80);
      expect(isSubstantiveApproach(text)).toBe(false);
    });

    it('returns true for substantive approach with no blocklist phrases', () => {
      const text = "I will implement the login page by adding a new route at /auth/login, reusing the existing AuthForm component " + "x".repeat(20);
      expect(isSubstantiveApproach(text)).toBe(true);
    });
  });

  describe('case insensitivity', () => {
    it('matches blocklist phrases in uppercase', () => {
      const text = "ON IT and ready to go with full implementation details " + "x".repeat(60);
      expect(isSubstantiveApproach(text)).toBe(false);
    });

    it('matches blocklist phrases as substrings', () => {
      const text = "I'm on it and ready with a detailed plan for the whole system " + "x".repeat(50);
      expect(isSubstantiveApproach(text)).toBe(false);
    });
  });
});
