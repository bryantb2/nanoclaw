import { describe, it, expect } from 'vitest';
import { resolveGoogleServiceAccountJson } from './google-service-account-env.js';

const SAMPLE_JSON =
  '{"type":"service_account","client_email":"x@y.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n"}';

describe('resolveGoogleServiceAccountJson', () => {
  it('decodes _B64 when set', () => {
    const b64 = Buffer.from(SAMPLE_JSON, 'utf8').toString('base64');
    expect(
      resolveGoogleServiceAccountJson({
        GOOGLE_SERVICE_ACCOUNT_JSON_B64: b64,
      }),
    ).toBe(SAMPLE_JSON);
  });

  it('prefers _B64 over plain when both are set', () => {
    const b64 = Buffer.from(SAMPLE_JSON, 'utf8').toString('base64');
    expect(
      resolveGoogleServiceAccountJson({
        GOOGLE_SERVICE_ACCOUNT_JSON_B64: b64,
        GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"OLD_PLAIN_THAT_SHOULD_LOSE"}',
      }),
    ).toBe(SAMPLE_JSON);
  });

  it('falls back to plain when only plain is set', () => {
    expect(
      resolveGoogleServiceAccountJson({
        GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"plain"}',
      }),
    ).toBe('{"type":"plain"}');
  });

  it('returns undefined when neither is set', () => {
    expect(resolveGoogleServiceAccountJson({})).toBeUndefined();
  });

  it('falls back to plain when _B64 is empty string', () => {
    expect(
      resolveGoogleServiceAccountJson({
        GOOGLE_SERVICE_ACCOUNT_JSON_B64: '',
        GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"plain"}',
      }),
    ).toBe('{"type":"plain"}');
  });

  it('falls back to plain when _B64 contains only whitespace (decodes empty)', () => {
    expect(
      resolveGoogleServiceAccountJson({
        GOOGLE_SERVICE_ACCOUNT_JSON_B64: '   ',
        GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"plain"}',
      }),
    ).toBe('{"type":"plain"}');
  });

  it('returns the (junk) decoded bytes when _B64 is non-empty garbage and no plain is set', () => {
    // We do not validate JSON in the helper — downstream parser surfaces
    // the error so the operator notices the mis-config instead of us
    // silently masking it with a different value.
    const result = resolveGoogleServiceAccountJson({
      GOOGLE_SERVICE_ACCOUNT_JSON_B64: 'not-real-base64!!!',
    });
    expect(typeof result).toBe('string');
    expect(result?.length).toBeGreaterThan(0);
  });
});
