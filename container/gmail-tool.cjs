#!/usr/bin/env node
'use strict';

// gmail-tool.cjs — Gmail CLI for fleet agents
//
// Usage:
//   node gmail-tool.cjs send --to <email> --subject <subject> --body <body>
//   node gmail-tool.cjs send --to <email> --subject <subject> --body <body> --cc <email> --bcc <email>
//   node gmail-tool.cjs send --to <email> --subject <subject> --body <body> --attach <filepath>
//   node gmail-tool.cjs reply --id <messageId> --body <body>
//   node gmail-tool.cjs list [--query <gmail-query>] [--max <count>]
//   node gmail-tool.cjs read <messageId>
//   node gmail-tool.cjs search <query>
//   node gmail-tool.cjs labels
//
// Auth: GOOGLE_SERVICE_ACCOUNT_JSON env var (JSON key from GCP service account with
// domain-wide delegation). Injected via entrypoint.sh from Infisical /integrations.

const { google, getAuth, parseFlags, handleApiError } = require('./google-workspace-utils.cjs');
const fs = require('fs');
const path = require('path');

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

function getGmail() {
  return google.gmail({ version: 'v1', auth: getAuth(GMAIL_SCOPES) });
}

function getHeader(headers, name) {
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// ---------------------------------------------------------------------------
// Command: send --to <email> --subject <subject> --body <body> [--cc <email>] [--bcc <email>] [--attach <filepath>]
// ---------------------------------------------------------------------------

async function cmdSend(args) {
  const opts = parseFlags(args, ['to', 'subject', 'body', 'cc', 'bcc', 'attach']);
  if (!opts.to || !opts.subject || !opts.body) {
    console.error('Usage: gmail-tool.cjs send --to <email> --subject <subject> --body <body> [--cc <email>] [--bcc <email>] [--attach <filepath>]');
    process.exit(1);
  }

  const gmail = getGmail();

  let raw;
  if (opts.attach) {
    // Multipart MIME with attachment
    const boundary = 'boundary_fleet_' + Date.now();
    const filename = path.basename(opts.attach);
    const fileContent = fs.readFileSync(opts.attach).toString('base64');
    const mimeType = guessMimeType(filename);

    const headers = [
      `To: ${opts.to}`,
      opts.cc ? `Cc: ${opts.cc}` : null,
      opts.bcc ? `Bcc: ${opts.bcc}` : null,
      `Subject: ${opts.subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ].filter(Boolean).join('\r\n');

    const message =
      `${headers}\r\n\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
      `${opts.body}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `Content-Disposition: attachment; filename="${filename}"\r\n\r\n` +
      `${fileContent}\r\n` +
      `--${boundary}--`;

    raw = Buffer.from(message).toString('base64url');
  } else {
    // Simple text email
    const headers = [
      `To: ${opts.to}`,
      opts.cc ? `Cc: ${opts.cc}` : null,
      opts.bcc ? `Bcc: ${opts.bcc}` : null,
      `Subject: ${opts.subject}`,
      'Content-Type: text/plain; charset=utf-8',
    ].filter(Boolean).join('\r\n');

    raw = Buffer.from(`${headers}\r\n\r\n${opts.body}`).toString('base64url');
  }

  try {
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });
    console.log(JSON.stringify({ status: 'sent', messageId: res.data.id, threadId: res.data.threadId }));
  } catch (err) {
    handleApiError(err, 'messages.send');
  }
}

// ---------------------------------------------------------------------------
// Command: reply --id <messageId> --body <body>
// ---------------------------------------------------------------------------

async function cmdReply(args) {
  const opts = parseFlags(args, ['id', 'body']);
  if (!opts.id || !opts.body) {
    console.error('Usage: gmail-tool.cjs reply --id <messageId> --body <body>');
    process.exit(1);
  }

  const gmail = getGmail();

  // Fetch the original message to get headers
  let original;
  try {
    original = await gmail.users.messages.get({
      userId: 'me',
      id: opts.id,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Message-ID'],
    });
  } catch (err) {
    handleApiError(err, 'messages.get (for reply)');
  }

  const headers = original.data.payload.headers;

  const from = getHeader(headers, 'From');
  const subject = getHeader(headers, 'Subject');
  const messageId = getHeader(headers, 'Message-ID');
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  const raw = Buffer.from(
    `To: ${from}\r\n` +
    `Subject: ${replySubject}\r\n` +
    `In-Reply-To: ${messageId}\r\n` +
    `References: ${messageId}\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
    opts.body
  ).toString('base64url');

  try {
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId: original.data.threadId },
    });
    console.log(JSON.stringify({ status: 'replied', messageId: res.data.id, threadId: res.data.threadId }));
  } catch (err) {
    handleApiError(err, 'messages.send (reply)');
  }
}

// ---------------------------------------------------------------------------
// Command: list [--query <gmail-query>] [--max <count>]
// ---------------------------------------------------------------------------

async function cmdList(args) {
  const opts = parseFlags(args, ['query', 'max']);
  const maxResults = parseInt(opts.max || '10', 10);
  const query = opts.query || 'is:inbox';

  const gmail = getGmail();

  let res;
  try {
    res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });
  } catch (err) {
    handleApiError(err, 'messages.list');
  }

  if (!res.data.messages || res.data.messages.length === 0) {
    console.log('[]');
    return;
  }

  // Fetch metadata for all messages in parallel
  const summaries = await Promise.all(
    res.data.messages.map(async (msg) => {
      try {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        });
        const headers = detail.data.payload.headers;
        return {
          id: msg.id,
          threadId: msg.threadId,
          from: getHeader(headers, 'From'),
          to: getHeader(headers, 'To'),
          subject: getHeader(headers, 'Subject'),
          date: getHeader(headers, 'Date'),
          snippet: detail.data.snippet,
          labelIds: detail.data.labelIds,
        };
      } catch (err) {
        return { id: msg.id, error: err.message };
      }
    })
  );

  console.log(JSON.stringify(summaries, null, 2));
}

// ---------------------------------------------------------------------------
// Command: read <messageId>
// ---------------------------------------------------------------------------

async function cmdRead(messageId) {
  if (!messageId) {
    console.error('Usage: gmail-tool.cjs read <messageId>');
    process.exit(1);
  }

  const gmail = getGmail();

  let res;
  try {
    res = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
  } catch (err) {
    handleApiError(err, 'messages.get');
  }

  const headers = res.data.payload.headers;
  const body = extractBody(res.data.payload);

  console.log(JSON.stringify({
    id: res.data.id,
    threadId: res.data.threadId,
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    cc: getHeader(headers, 'Cc'),
    subject: getHeader(headers, 'Subject'),
    date: getHeader(headers, 'Date'),
    snippet: res.data.snippet,
    labelIds: res.data.labelIds,
    body,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// Command: search <query>
// ---------------------------------------------------------------------------

async function cmdSearch(query) {
  if (!query) {
    console.error('Usage: gmail-tool.cjs search <query>');
    process.exit(1);
  }
  // Delegate to list with the query
  await cmdList(['--query', query, '--max', '20']);
}

// ---------------------------------------------------------------------------
// Command: labels
// ---------------------------------------------------------------------------

async function cmdLabels() {
  const gmail = getGmail();

  let res;
  try {
    res = await gmail.users.labels.list({ userId: 'me' });
  } catch (err) {
    handleApiError(err, 'labels.list');
  }

  const labels = (res.data.labels || []).map(l => ({
    id: l.id,
    name: l.name,
    type: l.type,
  }));

  console.log(JSON.stringify(labels, null, 2));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractBody(payload) {
  // Try to get plain text body
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  // Multipart: recurse into parts
  if (payload.parts) {
    // Prefer text/plain over text/html
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
    }
    // Fallback to html
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
    }
  }

  return null;
}

function guessMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return types[ext] || 'application/octet-stream';
}

// Exports for testing (not used at runtime)
exports._extractBody = extractBody;
exports._guessMimeType = guessMimeType;
exports._getHeader = getHeader;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Only run CLI when executed directly (not when required for testing)
if (require.main !== module) return;

const [,, cmd, ...rest] = process.argv;

(async () => {
  switch (cmd) {
    case 'send':
      await cmdSend(rest);
      break;
    case 'reply':
      await cmdReply(rest);
      break;
    case 'list':
      await cmdList(rest);
      break;
    case 'read':
      await cmdRead(rest[0]);
      break;
    case 'search':
      await cmdSearch(rest.join(' '));
      break;
    case 'labels':
      await cmdLabels();
      break;
    default:
      console.error(
        'Usage:\n' +
        '  node gmail-tool.cjs send --to <email> --subject <subject> --body <body> [--cc <email>] [--bcc <email>] [--attach <filepath>]\n' +
        '  node gmail-tool.cjs reply --id <messageId> --body <body>\n' +
        '  node gmail-tool.cjs list [--query <gmail-query>] [--max <count>]\n' +
        '  node gmail-tool.cjs read <messageId>\n' +
        '  node gmail-tool.cjs search <query>\n' +
        '  node gmail-tool.cjs labels\n' +
        '\n' +
        'Auth: Uses GOOGLE_SERVICE_ACCOUNT_JSON env var with domain-wide delegation\n' +
        'to impersonate fleet@krewtrack.com.'
      );
      process.exit(1);
  }
})();
