/**
 * Canary test: verifies APPROACH_BLOCKLIST and isSubstantiveApproach are
 * identical between index.ts and ipc-mcp-stdio.ts.
 *
 * Both files inline the same logic (SDK dependency prevents shared import).
 * This test reads the source files and asserts the implementations match,
 * catching drift before it causes gate bypass or false denials.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, 'src', 'index.ts');
const IPC_PATH = path.join(__dirname, 'src', 'ipc-mcp-stdio.ts');

function extractBlocklist(source) {
  const match = source.match(/(?:export\s+)?const\s+APPROACH_BLOCKLIST\s*=\s*\[([^\]]+)\]/);
  if (!match) return null;
  return match[1]
    .split(',')
    .map(s => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function extractIsSubstantiveBody(source) {
  // Extract the function body between { and the closing }
  const match = source.match(/function\s+isSubstantiveApproach\s*\([^)]*\)[^{]*\{([\s\S]*?)^\}/m);
  if (!match) return null;
  // Normalize whitespace for comparison
  return match[1].replace(/\s+/g, ' ').trim();
}

describe('blocklist sync between index.ts and ipc-mcp-stdio.ts', () => {
  let indexSource;
  let ipcSource;

  // Read both source files
  try {
    indexSource = fs.readFileSync(INDEX_PATH, 'utf-8');
    ipcSource = fs.readFileSync(IPC_PATH, 'utf-8');
  } catch {
    // Files might not exist in CI or when running from different dir
  }

  it('both files exist and are readable', () => {
    expect(indexSource).toBeDefined();
    expect(ipcSource).toBeDefined();
  });

  it('APPROACH_BLOCKLIST arrays are identical', () => {
    const indexList = extractBlocklist(indexSource);
    const ipcList = extractBlocklist(ipcSource);

    expect(indexList).not.toBeNull();
    expect(ipcList).not.toBeNull();
    expect(indexList).toEqual(ipcList);
  });

  it('isSubstantiveApproach function bodies match', () => {
    const indexBody = extractIsSubstantiveBody(indexSource);
    const ipcBody = extractIsSubstantiveBody(ipcSource);

    expect(indexBody).not.toBeNull();
    expect(ipcBody).not.toBeNull();
    expect(indexBody).toBe(ipcBody);
  });

  it('both files contain the sync comment', () => {
    // ipc-mcp-stdio.ts should have the sync warning
    expect(ipcSource).toMatch(/must stay in sync/i);
  });
});
