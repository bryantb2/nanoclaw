#!/usr/bin/env node
'use strict';

// drive-tool.js — Thin Google Drive/Docs CLI wrapper for fleet agents
//
// Usage:
//   node drive-tool.js read <fileId>
//   node drive-tool.js write --folder <folderId> --title <title> --content <content>
//   node drive-tool.js list --folder <folderId>
//
// Auth: GOOGLE_SERVICE_ACCOUNT_JSON env var (JSON key from GCP service account with
// domain-wide delegation). Injected via entrypoint.sh from Infisical /integrations.

const { google } = require('googleapis');

// ---------------------------------------------------------------------------
// Auth setup
// ---------------------------------------------------------------------------

function getAuth() {
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

  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
    ],
    subject: 'fleet@krewtrack.com', // domain-wide delegation impersonation
  });

  return auth;
}

// ---------------------------------------------------------------------------
// Command: read <fileId>
// ---------------------------------------------------------------------------

async function cmdRead(fileId) {
  if (!fileId) {
    console.error('Usage: drive-tool.js read <fileId>');
    process.exit(1);
  }

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  // Get file metadata to determine mimeType
  let meta;
  try {
    meta = await drive.files.get({
      fileId,
      fields: 'id,name,mimeType',
      supportsAllDrives: true,
    });
  } catch (err) {
    handleApiError(err, 'files.get');
  }

  const mimeType = meta.data.mimeType;

  try {
    if (mimeType === 'application/vnd.google-apps.document') {
      // Export Google Docs as plain text
      const res = await drive.files.export(
        { fileId, mimeType: 'text/plain', supportsAllDrives: true },
        { responseType: 'text' }
      );
      process.stdout.write(res.data);
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      // Export Google Sheets as CSV
      const res = await drive.files.export(
        { fileId, mimeType: 'text/csv', supportsAllDrives: true },
        { responseType: 'text' }
      );
      process.stdout.write(res.data);
    } else {
      // Download binary/text file as media
      const res = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'text' }
      );
      process.stdout.write(res.data);
    }
  } catch (err) {
    handleApiError(err, 'files.export/get');
  }
}

// ---------------------------------------------------------------------------
// Command: write --folder <folderId> --title <title> --content <content>
// ---------------------------------------------------------------------------

async function cmdWrite(args) {
  const opts = parseFlags(args, ['folder', 'title', 'content']);
  if (!opts.folder || !opts.title || !opts.content) {
    console.error('Usage: drive-tool.js write --folder <folderId> --title <title> --content <content>');
    process.exit(1);
  }

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const docs = google.docs({ version: 'v1', auth });

  // Step 1: Create blank Google Doc
  let docRes;
  try {
    docRes = await docs.documents.create({
      requestBody: { title: opts.title },
    });
  } catch (err) {
    handleApiError(err, 'documents.create');
  }

  const docId = docRes.data.documentId;

  // Step 2: Insert content via batchUpdate at index 1
  try {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: opts.content,
            },
          },
        ],
      },
    });
  } catch (err) {
    handleApiError(err, 'documents.batchUpdate');
  }

  // Step 3: Move doc to target folder (out of service account root)
  try {
    await drive.files.update({
      fileId: docId,
      addParents: opts.folder,
      removeParents: 'root',
      fields: 'id,parents',
      supportsAllDrives: true,
    });
  } catch (err) {
    handleApiError(err, 'files.update (move to folder)');
  }

  const url = `https://docs.google.com/document/d/${docId}`;
  console.log(url);
}

// ---------------------------------------------------------------------------
// Command: list --folder <folderId>
// ---------------------------------------------------------------------------

async function cmdList(args) {
  const opts = parseFlags(args, ['folder']);
  if (!opts.folder) {
    console.error('Usage: drive-tool.js list --folder <folderId>');
    process.exit(1);
  }

  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  let res;
  try {
    res = await drive.files.list({
      q: `'${opts.folder}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType)',
      // CRITICAL: Both flags required for Shared Drives — omitting either returns empty results
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
  } catch (err) {
    handleApiError(err, 'files.list');
  }

  console.log(JSON.stringify(res.data.files || [], null, 2));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const [,, cmd, ...rest] = process.argv;

(async () => {
  switch (cmd) {
    case 'read':
      await cmdRead(rest[0]);
      break;
    case 'write':
      await cmdWrite(rest);
      break;
    case 'list':
      await cmdList(rest);
      break;
    default:
      console.error(
        'Usage:\n' +
        '  node drive-tool.js read <fileId>\n' +
        '  node drive-tool.js write --folder <folderId> --title <title> --content <content>\n' +
        '  node drive-tool.js list --folder <folderId>'
      );
      process.exit(1);
  }
})();
