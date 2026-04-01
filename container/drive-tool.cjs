#!/usr/bin/env node
'use strict';

// drive-tool.cjs — Google Drive/Docs CLI for fleet agents
//
// Usage:
//   node drive-tool.cjs read <fileId>
//   node drive-tool.cjs write --folder <name-or-id> --title <title> --content <content>
//   node drive-tool.cjs list --folder <name-or-id>
//   node drive-tool.cjs search <query>
//   node drive-tool.cjs resolve <folder-name-or-path>
//
// Folder names are resolved against the Krewtrack Shared Drive.
// Paths like "Product Development/Software PRD" walk the folder tree.
// Raw IDs (22+ chars or containing underscores/hyphens) are used as-is.
//
// Auth: GOOGLE_SERVICE_ACCOUNT_JSON env var (JSON key from GCP service account with
// domain-wide delegation). Injected via entrypoint.sh from Infisical /integrations.

const { google, getAuth, parseFlags, handleApiError } = require('./google-workspace-utils.cjs');

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
];

// Krewtrack Shared Drive ID (from drive URL)
const SHARED_DRIVE_ID = '0AK8IOyoGnf6kUk9PVA';

// ---------------------------------------------------------------------------
// Folder resolution: name/path → ID
// ---------------------------------------------------------------------------

function looksLikeId(str) {
  // Drive IDs are typically 20+ chars with alphanumeric, hyphens, underscores
  return /^[A-Za-z0-9_-]{15,}$/.test(str);
}

async function resolveFolderByName(drive, name, parentId) {
  const q = parentId
    ? `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
    : `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

  const res = await drive.files.list({
    q,
    fields: 'files(id,name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    driveId: SHARED_DRIVE_ID,
    corpora: 'drive',
  });

  if (!res.data.files || res.data.files.length === 0) {
    return null;
  }
  return res.data.files[0];
}

async function resolveFolder(drive, folderArg) {
  // If it looks like a raw ID, use as-is
  if (looksLikeId(folderArg)) {
    return folderArg;
  }

  // Split path segments: "Product Development/Software PRD" → ["Product Development", "Software PRD"]
  const segments = folderArg.split('/').map(s => s.trim()).filter(Boolean);

  let parentId = SHARED_DRIVE_ID;
  for (const segment of segments) {
    const folder = await resolveFolderByName(drive, segment, parentId);
    if (!folder) {
      console.error(
        `Error: Folder "${segment}" not found` +
        (parentId !== SHARED_DRIVE_ID ? ` inside parent ${parentId}` : ' on the Krewtrack Shared Drive') +
        '.\nAvailable folders:'
      );
      // List available folders to help the user
      const available = await drive.files.list({
        q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        driveId: SHARED_DRIVE_ID,
        corpora: 'drive',
      });
      (available.data.files || []).forEach(f => console.error(`  - ${f.name}`));
      process.exit(1);
    }
    parentId = folder.id;
  }

  return parentId;
}

// ---------------------------------------------------------------------------
// Command: read <fileId>
// ---------------------------------------------------------------------------

async function cmdRead(fileId) {
  if (!fileId) {
    console.error('Usage: drive-tool.cjs read <fileId>');
    process.exit(1);
  }

  const auth = getAuth(DRIVE_SCOPES);
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
      const res = await drive.files.export(
        { fileId, mimeType: 'text/plain', supportsAllDrives: true },
        { responseType: 'text' }
      );
      process.stdout.write(res.data);
    } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      const res = await drive.files.export(
        { fileId, mimeType: 'text/csv', supportsAllDrives: true },
        { responseType: 'text' }
      );
      process.stdout.write(res.data);
    } else {
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
// Command: write --folder <name-or-id> --title <title> --content <content>
// ---------------------------------------------------------------------------

async function cmdWrite(args) {
  const opts = parseFlags(args, ['folder', 'title', 'content']);
  if (!opts.folder || !opts.title || !opts.content) {
    console.error('Usage: drive-tool.cjs write --folder <name-or-id> --title <title> --content <content>');
    process.exit(1);
  }

  const auth = getAuth(DRIVE_SCOPES);
  const drive = google.drive({ version: 'v3', auth });
  const docs = google.docs({ version: 'v1', auth });

  // Resolve folder name to ID
  const folderId = await resolveFolder(drive, opts.folder);

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

  // Step 2: Insert content
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

  // Step 3: Move doc to target folder
  try {
    await drive.files.update({
      fileId: docId,
      addParents: folderId,
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
// Command: list --folder <name-or-id>
// ---------------------------------------------------------------------------

async function cmdList(args) {
  const opts = parseFlags(args, ['folder']);
  if (!opts.folder) {
    console.error('Usage: drive-tool.cjs list --folder <name-or-id>');
    process.exit(1);
  }

  const auth = getAuth(DRIVE_SCOPES);
  const drive = google.drive({ version: 'v3', auth });

  // Resolve folder name to ID
  const folderId = await resolveFolder(drive, opts.folder);

  let res;
  try {
    res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
  } catch (err) {
    handleApiError(err, 'files.list');
  }

  console.log(JSON.stringify(res.data.files || [], null, 2));
}

// ---------------------------------------------------------------------------
// Command: search <query>
// ---------------------------------------------------------------------------

async function cmdSearch(query) {
  if (!query) {
    console.error('Usage: drive-tool.cjs search <query>');
    process.exit(1);
  }

  const auth = getAuth(DRIVE_SCOPES);
  const drive = google.drive({ version: 'v3', auth });

  let res;
  try {
    res = await drive.files.list({
      q: `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
      fields: 'files(id,name,mimeType,parents)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      driveId: SHARED_DRIVE_ID,
      corpora: 'drive',
      pageSize: 20,
    });
  } catch (err) {
    handleApiError(err, 'files.list (search)');
  }

  console.log(JSON.stringify(res.data.files || [], null, 2));
}

// ---------------------------------------------------------------------------
// Command: resolve <folder-name-or-path>
// ---------------------------------------------------------------------------

async function cmdResolve(folderArg) {
  if (!folderArg) {
    console.error('Usage: drive-tool.cjs resolve <folder-name-or-path>');
    process.exit(1);
  }

  const auth = getAuth(DRIVE_SCOPES);
  const drive = google.drive({ version: 'v3', auth });

  const folderId = await resolveFolder(drive, folderArg);
  console.log(folderId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    case 'search':
      await cmdSearch(rest.join(' '));
      break;
    case 'resolve':
      await cmdResolve(rest.join('/'));
      break;
    default:
      console.error(
        'Usage:\n' +
        '  node drive-tool.cjs read <fileId>\n' +
        '  node drive-tool.cjs write --folder <name-or-path> --title <title> --content <content>\n' +
        '  node drive-tool.cjs list --folder <name-or-path>\n' +
        '  node drive-tool.cjs search <query>\n' +
        '  node drive-tool.cjs resolve <folder-name-or-path>\n' +
        '\n' +
        'Folder can be a Drive ID or a name/path like "Product Development/Software PRD".\n' +
        'Paths are resolved against the Krewtrack Shared Drive.'
      );
      process.exit(1);
  }
})();
