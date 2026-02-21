import { createMiddleware } from 'hono/factory';
import { getDb } from '../db';
import { ApiError, now, type HonoEnv } from '../types';

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

export const authMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);
  const db = getDb(c.var.db);
  const stripeSecretKey = c.env.STRIPE_SECRET_KEY || null;
  const stripeWebhookSecret = c.env.STRIPE_WEBHOOK_SECRET || null;

  const isOAuthToken = token.length === 64 && /^[a-f0-9]+$/.test(token);
  if (isOAuthToken) {
    const tokenHash = await hashKey(token);
    const oauthResult = await db.query<any>(
      `SELECT t.*, c.email as customer_email
       FROM oauth_tokens t
       JOIN customers c ON t.customer_id = c.id
       WHERE t.access_token_hash = ? AND t.access_expires_at > ?
       LIMIT 1`,
      [tokenHash, now()]
    );

    if (oauthResult.length > 0) {
      const row = oauthResult[0];
      c.set('auth', {
        role: 'oauth',
        stripeSecretKey,
        stripeWebhookSecret,
        oauthScopes: row.scope?.split(' ') || [],
        customerEmail: row.customer_email,
      });

      await next();
      return;
    }
  }

  const keyHash = await hashKey(token);
  const result = await db.query<any>(
    `SELECT role FROM api_keys WHERE key_hash = ? LIMIT 1`,
    [keyHash]
  );

  if (result.length === 0) {
    throw ApiError.unauthorized('Invalid API key');
  }

  c.set('auth', {
    role: result[0].role,
    stripeSecretKey,
    stripeWebhookSecret,
  });

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
      const hasAllScopes = requiredScopes.every(
        (scope) => auth.oauthScopes?.includes(scope)
      );
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
