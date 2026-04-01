import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getAuth, parseFlags, handleApiError } = require('./google-workspace-utils.cjs');

const VALID_SERVICE_ACCOUNT = JSON.stringify({
  client_email: 'test@project.iam.gserviceaccount.com',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
});

describe('google-workspace-utils', () => {
  describe('getAuth', () => {
    let originalEnv;

    beforeEach(() => {
      originalEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.GOOGLE_SERVICE_ACCOUNT_JSON = originalEnv;
      } else {
        delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      }
    });

    it('returns a JWT auth object', () => {
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON = VALID_SERVICE_ACCOUNT;
      const auth = getAuth(['https://www.googleapis.com/auth/gmail.modify']);
      // google.auth.JWT is a constructor — getAuth returns an instance
      expect(auth).toBeDefined();
    });

    it('exits when env var is not set', () => {
      delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => getAuth(['scope'])).toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('GOOGLE_SERVICE_ACCOUNT_JSON'));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('exits when env var is invalid JSON', () => {
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON = 'not-json';
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => getAuth(['scope'])).toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('parseFlags', () => {
    it('parses key-value flags', () => {
      expect(parseFlags(['--to', 'a@b.com', '--subject', 'Hi'], ['to', 'subject']))
        .toEqual({ to: 'a@b.com', subject: 'Hi' });
    });

    it('ignores unrecognized flags', () => {
      expect(parseFlags(['--to', 'a@b.com', '--unknown', 'val'], ['to']))
        .toEqual({ to: 'a@b.com' });
    });

    it('returns empty object for no args', () => {
      expect(parseFlags([], ['to'])).toEqual({});
    });

    it('handles flag at end with no value', () => {
      expect(parseFlags(['--to'], ['to'])).toEqual({ to: '' });
    });

    it('skips positional args', () => {
      expect(parseFlags(['positional', '--to', 'a@b.com', 'extra'], ['to']))
        .toEqual({ to: 'a@b.com' });
    });
  });

  describe('handleApiError', () => {
    it('exits with code 1 and includes context', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => handleApiError(new Error('oops'), 'files.list')).toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('files.list'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('oops'));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('shows delegation hint for unauthorized_client', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => handleApiError(new Error('unauthorized_client'), 'test')).toThrow('exit');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Domain-wide delegation'));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('handles non-Error objects', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => handleApiError('string error', 'test')).toThrow('exit');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('string error'));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});
