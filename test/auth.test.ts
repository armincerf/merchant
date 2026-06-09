/**
 * Auth middleware integration tests.
 *
 * Covers: missing auth header, wrong header format, invalid key,
 * valid public key (pk), valid admin key (sk), admin-only endpoint
 * rejection with public key.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { seedStore, authedFetch, anonFetch, jsonBody, type SeedResult } from './helpers';

let seed: SeedResult;

beforeAll(async () => {
  seed = await seedStore();
});

describe('auth middleware', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await anonFetch('/v1/products');
    expect(res.status).toBe(401);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns 401 when Authorization header does not start with Bearer', async () => {
    const res = await SELF.fetch('http://example.com/v1/products', {
      headers: { Authorization: 'Basic abc123' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a completely invalid API key', async () => {
    const res = await SELF.fetch('http://example.com/v1/products', {
      headers: { Authorization: 'Bearer invalid_key_that_does_not_exist' },
    });
    expect(res.status).toBe(401);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('unauthorized');
  });

  it('accepts a valid public key (pk) and returns products', async () => {
    const res = await authedFetch('/v1/products', seed.pk);
    expect(res.status).toBe(200);
    const body = await jsonBody<{ items: unknown[] }>(res);
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('accepts a valid admin key (sk) and returns products', async () => {
    const res = await authedFetch('/v1/products', seed.sk);
    expect(res.status).toBe(200);
  });

  it('returns 403 when public key tries to create a product (admin-only)', async () => {
    const res = await authedFetch('/v1/products', seed.pk, {
      method: 'POST',
      body: JSON.stringify({ title: 'Should fail' }),
    });
    expect(res.status).toBe(403);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('forbidden');
  });

  it('returns 403 when public key tries to adjust inventory (admin-only)', async () => {
    const res = await authedFetch(`/v1/inventory/${seed.sku}/adjust`, seed.pk, {
      method: 'POST',
      body: JSON.stringify({ delta: 5, reason: 'restock' }),
    });
    expect(res.status).toBe(403);
  });
});
