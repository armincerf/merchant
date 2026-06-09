import { createMiddleware } from 'hono/factory';
import { ApiError, type HonoEnv } from '../types';
import { hashKey } from './auth';

// ============================================================
// IDEMPOTENCY MIDDLEWARE
// ============================================================
//
// Implements Stripe-style Idempotency-Key support.
//
// - No Idempotency-Key header → pass through unchanged.
// - With header:
//   - key length < 8 or > 255 chars → 400 invalid_request
//   - 'replay'     → return cached response, Idempotency-Replayed: true
//   - 'conflict'   → 409 idempotency_conflict
//   - 'in_flight'  → 409 idempotency_in_flight
//   - 'new'        → execute handler, cache response if status < 500
//
// NOTE: Only successful/handled responses (status < 500) are cached.
// Errors that are thrown (ApiError and unexpected errors) are NOT cached —
// the key is released so the client can retry. This means 4xx errors from
// ApiError.onError handlers are re-executed on each retry, which is the
// correct Stripe-compatible behaviour.
//
// keyHash   = SHA-256(authorization-header-identity + ':' + raw-key)
//             Including the bearer token in the hash input prevents different
//             API keys from colliding on or reading each other's cached responses.
// requestHash = SHA-256(method + path + raw-body-text)

export function idempotencyMiddleware() {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const rawKey = c.req.header('Idempotency-Key');

    // No header — pass through
    if (!rawKey) {
      await next();
      return;
    }

    // Sanity-check key length
    if (rawKey.length < 8 || rawKey.length > 255) {
      throw ApiError.invalidRequest('Idempotency-Key must be between 8 and 255 characters');
    }

    // Build key hash — scoped to the bearer token so different callers can't
    // collide with or read each other's cached responses.
    const authHeader = c.req.header('Authorization') ?? '';
    const keyHash = await hashKey(`${authHeader}:${rawKey}`);

    // Build request hash — captures method + path + body so we can detect
    // requests that reuse a key but differ in content (→ conflict).
    const bodyText = await c.req.raw.clone().text();
    const requestHash = await hashKey(`${c.req.method}:${c.req.path}:${bodyText}`);

    const endpoint = `${c.req.method} ${c.req.path}`;

    const claimResult = await c.var.db.idempotencyClaim(keyHash, endpoint, requestHash);

    if (claimResult.state === 'replay') {
      return new Response(claimResult.body, {
        status: claimResult.status,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Replayed': 'true',
        },
      });
    }

    if (claimResult.state === 'conflict') {
      throw new ApiError(
        'idempotency_conflict',
        409,
        'A request with this Idempotency-Key was already made with a different request body',
      );
    }

    if (claimResult.state === 'in_flight') {
      throw new ApiError(
        'idempotency_in_flight',
        409,
        'A request with this Idempotency-Key is still being processed',
      );
    }

    // claimResult.state === 'new' — execute the handler
    try {
      await next();

      // If we get here, the handler completed without throwing.
      // Cache the response if status < 500.
      const res = c.res;
      if (res.status < 500) {
        const responseBody = await res.clone().text();
        await c.var.db.idempotencyComplete(keyHash, res.status, responseBody);
      } else {
        // 5xx — release so the client can retry
        await c.var.db.idempotencyRelease(keyHash);
      }
    } catch (err) {
      // Handler threw (typically an ApiError) — release the key so the client
      // can retry. We rethrow so that app.onError handles the response normally.
      await c.var.db.idempotencyRelease(keyHash);
      throw err;
    }
  });
}
