/**
 * Integration tests for the approach marker write logic in ipc-mcp-stdio.ts.
 *
 * Tests the full flow: send_message with qualifying text → marker file created.
 * Uses real filesystem operations with temp directories.
 *
 * Cannot import from ipc-mcp-stdio.ts (MCP SDK dependency), so we replicate
 * the marker write logic and test the contract it must satisfy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// --- Replicated from ipc-mcp-stdio.ts (lines 19-26) ---

const APPROACH_BLOCKLIST = ["on it", "confirmed", "working on this", "acknowledged", "queued"];

function isSubstantiveApproach(text) {
  if (text.length <= 100) return false;
  const lower = text.toLowerCase();
  return !APPROACH_BLOCKLIST.some(phrase => lower.includes(phrase));
}

/**
 * Replicated marker write logic from send_message handler (lines 75-81).
 * Uses configurable paths for testing.
 */
function writeApproachMarkerIfQualifying(text, isMain, markerPath) {
  if (!isMain && isSubstantiveApproach(text) && !fs.existsSync(markerPath)) {
    fs.writeFileSync(markerPath, JSON.stringify({
      postedAt: new Date().toISOString(),
      textLength: text.length,
      messageText: text,
    }));
    return true;
  }
  return false;
}

// --- Tests ---

describe('approach marker write integration', () => {
  let tmpDir;
  let markerPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-test-'));
    markerPath = path.join(tmpDir, 'approach-posted.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('marker creation on qualifying message', () => {
    it('creates marker file on first substantive message', () => {
      const text = 'I will implement the login page by adding a new route at /auth/login, reusing the existing AuthForm component and adding password validation';
      const wrote = writeApproachMarkerIfQualifying(text, false, markerPath);

      expect(wrote).toBe(true);
      expect(fs.existsSync(markerPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
      expect(content.postedAt).toBeDefined();
      expect(content.textLength).toBe(text.length);
      expect(content.messageText).toBe(text);
    });

    it('marker file is valid JSON with expected schema', () => {
      const text = 'Here is my detailed implementation approach for the feature request including database schema changes and API endpoints ' + 'x'.repeat(20);
      writeApproachMarkerIfQualifying(text, false, markerPath);

      const content = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
      expect(typeof content.postedAt).toBe('string');
      expect(typeof content.textLength).toBe('number');
      expect(content.textLength).toBeGreaterThan(100);
      expect(typeof content.messageText).toBe('string');
      expect(content.messageText).toBe(text);
      // Validate ISO 8601 timestamp
      expect(new Date(content.postedAt).toISOString()).toBe(content.postedAt);
    });
  });

  describe('idempotency (marker written only once)', () => {
    it('does not overwrite marker on second qualifying message', () => {
      const text1 = 'First substantive approach message with enough detail to pass the gate check and get the marker written to disk immediately';
      const text2 = 'Second substantive approach with different content and also enough characters to pass the gate validation check completely';

      writeApproachMarkerIfQualifying(text1, false, markerPath);
      const firstContent = fs.readFileSync(markerPath, 'utf-8');
      const firstParsed = JSON.parse(firstContent);

      writeApproachMarkerIfQualifying(text2, false, markerPath);
      const secondContent = fs.readFileSync(markerPath, 'utf-8');

      // Content should be identical — second write was skipped
      expect(secondContent).toBe(firstContent);
      expect(firstParsed.textLength).toBe(text1.length);
    });

    it('returns false on second qualifying message', () => {
      const text = 'Substantive approach message with plenty of detail about the implementation plan and technical decisions that need to be made';
      expect(writeApproachMarkerIfQualifying(text, false, markerPath)).toBe(true);
      expect(writeApproachMarkerIfQualifying(text, false, markerPath)).toBe(false);
    });
  });

  describe('isMain bypass (dispatch exempt)', () => {
    it('does not create marker when isMain is true', () => {
      const text = 'Dispatch agent sends a long message about implementation details for the login feature including database schema changes';
      const wrote = writeApproachMarkerIfQualifying(text, true, markerPath);

      expect(wrote).toBe(false);
      expect(fs.existsSync(markerPath)).toBe(false);
    });
  });

  describe('non-qualifying messages (no marker written)', () => {
    it('does not create marker for short messages', () => {
      const wrote = writeApproachMarkerIfQualifying('short', false, markerPath);
      expect(wrote).toBe(false);
      expect(fs.existsSync(markerPath)).toBe(false);
    });

    it('does not create marker for blocklisted "on it" message', () => {
      const text = "On it, I'll handle this task for you with a detailed implementation plan " + 'x'.repeat(50);
      const wrote = writeApproachMarkerIfQualifying(text, false, markerPath);
      expect(wrote).toBe(false);
      expect(fs.existsSync(markerPath)).toBe(false);
    });

    it('does not create marker for blocklisted "confirmed" message', () => {
      const text = "Confirmed — here is my detailed plan for the implementation with all the necessary changes listed out " + 'x'.repeat(20);
      const wrote = writeApproachMarkerIfQualifying(text, false, markerPath);
      expect(wrote).toBe(false);
      expect(fs.existsSync(markerPath)).toBe(false);
    });

    it('does not create marker for blocklisted "working on this" message', () => {
      const text = "Working on this and here is the approach with enough detail to make it past the length check easily " + 'x'.repeat(20);
      const wrote = writeApproachMarkerIfQualifying(text, false, markerPath);
      expect(wrote).toBe(false);
      expect(fs.existsSync(markerPath)).toBe(false);
    });

    it('does not create marker for exactly 100 char message', () => {
      const text = 'a'.repeat(100);
      const wrote = writeApproachMarkerIfQualifying(text, false, markerPath);
      expect(wrote).toBe(false);
      expect(fs.existsSync(markerPath)).toBe(false);
    });
  });

  describe('marker cleanup on startup', () => {
    it('stale marker from previous session can be cleaned up', () => {
      // Simulate stale marker from previous run
      fs.writeFileSync(markerPath, JSON.stringify({
        postedAt: '2026-01-01T00:00:00.000Z',
        textLength: 200,
      }));
      expect(fs.existsSync(markerPath)).toBe(true);

      // Simulate startup cleanup (index.ts line 719)
      try { fs.unlinkSync(markerPath); } catch { /* ignore */ }
      expect(fs.existsSync(markerPath)).toBe(false);

      // New marker can now be written
      const text = 'Fresh approach for this new session with a detailed implementation plan covering all the necessary changes';
      const wrote = writeApproachMarkerIfQualifying(text, false, markerPath);
      expect(wrote).toBe(true);
      expect(fs.existsSync(markerPath)).toBe(true);
    });

    it('cleanup handles missing marker gracefully', () => {
      expect(fs.existsSync(markerPath)).toBe(false);
      // Should not throw
      try { fs.unlinkSync(markerPath); } catch { /* ignore */ }
      expect(fs.existsSync(markerPath)).toBe(false);
    });
  });
});
