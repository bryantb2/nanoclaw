#!/usr/bin/env node
'use strict';

// github-token.cjs — On-demand GitHub App installation token generator
//
// Generates a fresh installation token for a given repo owner, with
// file-based caching (~55 min TTL) so repeated git operations don't
// hit the GitHub API every time.
//
// Usage:
//   node github-token.cjs <owner>        — prints token for owner (or fallback)
//   node github-token.cjs --all-json     — prints JSON array of all {account, token} pairs
//
// Env: GITHUB_APP_PRIVATE_KEY, GITHUB_APP_ID

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(process.env.HOME || '/home/node', '.github-token-cache');
const CACHE_TTL_MS = 55 * 60 * 1000; // 55 minutes (tokens expire at 60)

function createJwt(privateKey, appId) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  return `${signingInput}.${sign.sign(privateKey, 'base64url')}`;
}

async function fetchInstallations(jwt) {
  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nanoclaw',
  };

  const resp = await fetch('https://api.github.com/app/installations', { headers });
  if (!resp.ok) {
    throw new Error(`GitHub installations list failed: ${resp.status} ${await resp.text()}`);
  }
  return { installations: await resp.json(), headers };
}

async function generateToken(installationId, headers) {
  const resp = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    { method: 'POST', headers },
  );
  if (!resp.ok) {
    throw new Error(`Token generation failed for installation ${installationId}: ${resp.status}`);
  }
  const data = await resp.json();
  return data.token;
}

function getCached(owner) {
  try {
    const file = path.join(CACHE_DIR, `${owner.toLowerCase()}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Date.now() - data.timestamp < CACHE_TTL_MS) {
      return data.token;
    }
  } catch {
    // Cache miss or corrupt — regenerate
  }
  return null;
}

function setCache(owner, token) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const file = path.join(CACHE_DIR, `${owner.toLowerCase()}.json`);
    fs.writeFileSync(file, JSON.stringify({ token, timestamp: Date.now() }));
  } catch {
    // Non-fatal — token still works, just won't be cached
  }
}

async function getAllTokens(privateKey, appId) {
  const jwt = createJwt(privateKey, appId);
  const { installations, headers } = await fetchInstallations(jwt);

  const results = await Promise.all(
    installations.map(async (inst) => {
      const owner = inst.account.login.toLowerCase();
      const cached = getCached(owner);
      if (cached) return { account: inst.account.login, token: cached };
      try {
        const token = await generateToken(inst.id, headers);
        setCache(owner, token);
        return { account: inst.account.login, token };
      } catch (err) {
        process.stderr.write(`Warning: skipping ${inst.account.login}: ${err.message}\n`);
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

async function getTokenForOwner(owner, privateKey, appId) {
  // Check cache first
  const cached = getCached(owner);
  if (cached) return cached;

  // Generate fresh tokens for all installations (we need to find which
  // installation covers this owner)
  const tokens = await getAllTokens(privateKey, appId);
  const match = tokens.find(t => t.account.toLowerCase() === owner.toLowerCase());
  if (match) return match.token;

  // Fallback to first available token
  if (tokens.length > 0) return tokens[0].token;

  throw new Error(`No GitHub installation token available for owner: ${owner}`);
}

// --- Entry point ---
(async () => {
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const appId = process.env.GITHUB_APP_ID;

  if (!privateKey || !appId) {
    process.stderr.write('Error: GITHUB_APP_PRIVATE_KEY and GITHUB_APP_ID must be set\n');
    process.exit(1);
  }

  const arg = process.argv[2];

  if (arg === '--all-json') {
    const tokens = await getAllTokens(privateKey, appId);
    process.stdout.write(JSON.stringify(tokens));
  } else if (arg) {
    const token = await getTokenForOwner(arg, privateKey, appId);
    process.stdout.write(token);
  } else {
    process.stderr.write('Usage: node github-token.cjs <owner> | --all-json\n');
    process.exit(1);
  }
})().catch(err => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
