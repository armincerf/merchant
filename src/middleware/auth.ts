import { createMiddleware } from 'hono/factory';
import { getDb } from '../db';
import { ApiError, type HonoEnv, now } from '../types';

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

// In-isolate memo of api-key hash → role, so repeat callers skip the
// per-request DO round trip (the DO serializes ALL traffic; auth lookups were
// one of its biggest request classes). Positive lookups only — unknown keys
// always hit the DO. Key deletion clears this isolate's memo immediately
// (routes/keys.ts); other isolates can honor a revoked key for up to
// AUTH_MEMO_TTL_MS. OAuth tokens are never memoized: they expire and carry
// scopes, so they stay on the DO path.
export const AUTH_MEMO_TTL_MS = 60_000;
const AUTH_MEMO_MAX_ENTRIES = 500;
const keyRoleMemo = new Map<string, { role: 'public' | 'admin'; expiresAt: number }>();

/** Drop all memoized key roles in this isolate (call after key revocation). */
export function clearAuthMemo(): void {
  keyRoleMemo.clear();
}

export const authMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);
  const db = getDb(c.var.db);

  const isOAuthToken = token.length === 64 && /^[a-f0-9]+$/.test(token);
  if (isOAuthToken) {
    const tokenHash = await hashKey(token);
    const oauthResult = await db.query<any>(
      `SELECT t.*, c.email as customer_email
       FROM oauth_tokens t
       JOIN customers c ON t.customer_id = c.id
       WHERE t.access_token_hash = ? AND t.access_expires_at > ?
       LIMIT 1`,
      [tokenHash, now()],
    );

    if (oauthResult.length > 0) {
      const row = oauthResult[0];
      c.set('auth', {
        role: 'oauth',
        oauthScopes: row.scope?.split(' ') || [],
        customerEmail: row.customer_email,
      });

      await next();
      return;
    }
  }

  const keyHash = await hashKey(token);

  const memoized = keyRoleMemo.get(keyHash);
  if (memoized && memoized.expiresAt > Date.now()) {
    c.set('auth', { role: memoized.role });

    await next();
    return;
  }

  const result = await db.query<any>(`SELECT role FROM api_keys WHERE key_hash = ? LIMIT 1`, [
    keyHash,
  ]);

  if (result.length === 0) {
    throw ApiError.unauthorized('Invalid API key');
  }

  if (keyRoleMemo.size >= AUTH_MEMO_MAX_ENTRIES) {
    keyRoleMemo.clear();
  }
  keyRoleMemo.set(keyHash, { role: result[0].role, expiresAt: Date.now() + AUTH_MEMO_TTL_MS });

  c.set('auth', { role: result[0].role });

  await next();
});

export const adminOnly = createMiddleware<HonoEnv>(async (c, next) => {
  const auth = c.get('auth');

  if (auth.role !== 'admin') {
    throw ApiError.forbidden('Admin access required');
  }

  await next();
});

export function requireScope(...requiredScopes: string[]) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const auth = c.get('auth');

    if (auth.role === 'oauth') {
      const hasAllScopes = requiredScopes.every((scope) => auth.oauthScopes?.includes(scope));
      if (!hasAllScopes) {
        throw ApiError.forbidden(`Required scopes: ${requiredScopes.join(', ')}`);
      }
    }

    await next();
  });
}

export async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateApiKey(prefix: 'pk' | 'sk'): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const key = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}_${key}`;
}
