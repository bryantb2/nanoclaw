#!/usr/bin/env node
'use strict';

// google-workspace-utils.cjs — Shared utilities for Google Workspace CLI tools
//
// Used by drive-tool.cjs and gmail-tool.cjs. Auth uses a GCP service account
// with domain-wide delegation, impersonating fleet@krewtrack.com.
//
// Auth: GOOGLE_SERVICE_ACCOUNT_JSON env var (JSON key from GCP service account).
// Injected via entrypoint.sh from Infisical /integrations.

const { google } = require('googleapis');

/**
 * Create a Google Auth JWT client for the given scopes.
 * @param {string[]} scopes - OAuth scopes to request
 * @returns {import('googleapis').JWT}
 */
function getAuth(scopes) {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.error(
      'Error: GOOGLE_SERVICE_ACCOUNT_JSON env var is not set.\n' +
      'This secret must be injected from Infisical /integrations folder.\n' +
      'Ensure entrypoint.sh is configured with INFISICAL_FOLDERS="/clawhub,/integrations".'
    );
    process.exit(1);
  }

  let key;
  try {
    key = JSON.parse(raw);
  } catch (e) {
    console.error(
      'Error: GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.\n' +
      'If the private key contains literal \\n characters, ensure the value is stored\n' +
      'as a compact single-line JSON string in Infisical (not multi-line).'
    );
    process.exit(1);
  }

  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes,
    subject: 'fleet@krewtrack.com',
  });
}

/**
 * Parse --key value flags from a CLI args array.
 * @param {string[]} args
 * @param {string[]} keys - recognized flag names (without --)
 * @returns {Record<string, string>}
 */
function parseFlags(args, keys) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (keys.includes(key)) {
        result[key] = args[i + 1] || '';
        i++;
      }
    }
  }
  return result;
}

/**
 * Log a Google API error with context and exit.
 * Includes a hint for domain-wide delegation issues.
 * @param {Error} err
 * @param {string} context - e.g. 'messages.send', 'files.list'
 */
function handleApiError(err, context) {
  const msg = err.message || String(err);
  if (msg.includes('unauthorized_client')) {
    console.error(
      `Error [${context}]: unauthorized_client\n` +
      'Hint: Domain-wide delegation changes can take up to 24 hours to propagate.\n' +
      'Wait 5-15 minutes after adding delegation in Google Workspace Admin, then retry.\n' +
      'Also verify: service account client_id is added under Security > API Controls > Domain-wide Delegation.'
    );
  } else {
    console.error(`Error [${context}]: ${msg}`);
  }
  process.exit(1);
}

exports.google = google;
exports.getAuth = getAuth;
exports.parseFlags = parseFlags;
exports.handleApiError = handleApiError;
