import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// gmail-tool.cjs auto-runs its entry point on require, but the IIFE at the
// bottom only fires commands from process.argv which won't match in test.
// The _-prefixed exports give us access to the pure helpers.
const { _extractBody, _guessMimeType, _getHeader } = require('./gmail-tool.cjs');

describe('gmail-tool helpers', () => {
  describe('getHeader', () => {
    const headers = [
      { name: 'From', value: 'alice@example.com' },
      { name: 'To', value: 'bob@example.com' },
      { name: 'Subject', value: 'Test Subject' },
      { name: 'Message-ID', value: '<abc123@mail.example.com>' },
    ];

    it('finds header by exact name', () => {
      expect(_getHeader(headers, 'From')).toBe('alice@example.com');
    });

    it('is case-insensitive', () => {
      expect(_getHeader(headers, 'from')).toBe('alice@example.com');
      expect(_getHeader(headers, 'SUBJECT')).toBe('Test Subject');
    });

    it('returns empty string for missing header', () => {
      expect(_getHeader(headers, 'Cc')).toBe('');
    });

    it('returns empty string for empty headers array', () => {
      expect(_getHeader([], 'From')).toBe('');
    });
  });

  describe('extractBody', () => {
    it('extracts plain text from simple payload', () => {
      const payload = {
        mimeType: 'text/plain',
        body: { data: Buffer.from('Hello world').toString('base64') },
      };
      expect(_extractBody(payload)).toBe('Hello world');
    });

    it('prefers plain text over HTML in multipart', () => {
      const payload = {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('Plain').toString('base64') } },
          { mimeType: 'text/html', body: { data: Buffer.from('<b>HTML</b>').toString('base64') } },
        ],
      };
      expect(_extractBody(payload)).toBe('Plain');
    });

    it('falls back to HTML when no plain text', () => {
      const payload = {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/html', body: { data: Buffer.from('<b>HTML</b>').toString('base64') } },
        ],
      };
      expect(_extractBody(payload)).toBe('<b>HTML</b>');
    });

    it('recurses into nested multipart', () => {
      const payload = {
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { data: Buffer.from('Nested').toString('base64') } },
            ],
          },
          { mimeType: 'application/pdf', body: { data: 'binary' } },
        ],
      };
      expect(_extractBody(payload)).toBe('Nested');
    });

    it('returns null when no extractable body', () => {
      expect(_extractBody({
        mimeType: 'multipart/mixed',
        parts: [{ mimeType: 'application/pdf', body: { data: 'x' } }],
      })).toBeNull();
    });

    it('returns null for payload with no body data', () => {
      expect(_extractBody({ mimeType: 'text/plain' })).toBeNull();
    });

    it('handles UTF-8 content', () => {
      const payload = {
        mimeType: 'text/plain',
        body: { data: Buffer.from('Héllo 🌍').toString('base64') },
      };
      expect(_extractBody(payload)).toBe('Héllo 🌍');
    });
  });

  describe('guessMimeType', () => {
    it('maps known extensions', () => {
      expect(_guessMimeType('report.pdf')).toBe('application/pdf');
      expect(_guessMimeType('photo.jpg')).toBe('image/jpeg');
      expect(_guessMimeType('photo.jpeg')).toBe('image/jpeg');
      expect(_guessMimeType('image.png')).toBe('image/png');
      expect(_guessMimeType('data.csv')).toBe('text/csv');
      expect(_guessMimeType('doc.docx')).toContain('wordprocessingml');
      expect(_guessMimeType('sheet.xlsx')).toContain('spreadsheetml');
    });

    it('is case-insensitive', () => {
      expect(_guessMimeType('FILE.PDF')).toBe('application/pdf');
    });

    it('returns octet-stream for unknown extensions', () => {
      expect(_guessMimeType('file.xyz')).toBe('application/octet-stream');
    });

    it('handles paths with directories', () => {
      expect(_guessMimeType('/tmp/reports/q4.pdf')).toBe('application/pdf');
    });
  });
});
