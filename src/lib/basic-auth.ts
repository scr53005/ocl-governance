// Pure HTTP Basic Auth helpers for the operator gate (src/middleware.ts).
// Edge-runtime safe: no Node `Buffer`/`crypto` imports. Relative imports only
// (tested by Vitest — see basic-auth.test.ts).

export type BasicAuthResult = 'ok' | 'missing' | 'invalid' | 'unconfigured';

/** Length-independent constant-time-ish string comparison. */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Check an `Authorization: Basic …` header. Only the password is checked
 * (any username). Fails closed: an unset password never authorizes.
 */
export function checkBasicAuth(
  authHeader: string | null | undefined,
  expectedPassword: string | undefined,
): BasicAuthResult {
  if (!expectedPassword) return 'unconfigured';
  if (!authHeader || !authHeader.startsWith('Basic ')) return 'missing';
  let decoded: string;
  try {
    decoded = atob(authHeader.slice(6).trim());
  } catch {
    return 'invalid';
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return 'invalid';
  return constantTimeEqual(decoded.slice(sep + 1), expectedPassword) ? 'ok' : 'invalid';
}

/**
 * Which requests need the operator password.
 * - /provisioning page and every /api/ops/* route (they spend real money).
 * - Writes to /api/projections (reads stay public — the /debt page uses them).
 */
export function requiresOperatorAuth(pathname: string, method: string): boolean {
  if (pathname === '/provisioning' || pathname.startsWith('/provisioning/')) return true;
  if (pathname === '/api/ops' || pathname.startsWith('/api/ops/')) return true;
  if (pathname === '/api/projections' && method !== 'GET' && method !== 'HEAD') return true;
  return false;
}
