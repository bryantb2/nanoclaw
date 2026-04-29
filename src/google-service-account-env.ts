/**
 * Resolve the GOOGLE_SERVICE_ACCOUNT_JSON value to inject into spawned
 * containers.
 *
 * Why a base64 form: env files and shell single-quoting do not preserve
 * the `\n` escape sequences that JSON requires inside string literals
 * (most notably `private_key` in a service account key). Storing the
 * secret as base64 sidesteps the entire escaping/quoting class of bugs
 * — same pattern Infisical already uses for GITHUB_APP_PRIVATE_KEY_B64.
 *
 * Resolution order:
 *   1. GOOGLE_SERVICE_ACCOUNT_JSON_B64 (preferred — decoded as utf8)
 *   2. GOOGLE_SERVICE_ACCOUNT_JSON (legacy plain form)
 *
 * Returns undefined if neither is usable. The B64 form must decode to a
 * non-empty string to win; if it decodes empty we fall back to plain so
 * a stray empty B64 line doesn't black-hole a working plain value.
 */
export function resolveGoogleServiceAccountJson(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const b64 = env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  if (b64) {
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    if (decoded) return decoded;
  }
  return env.GOOGLE_SERVICE_ACCOUNT_JSON || undefined;
}
