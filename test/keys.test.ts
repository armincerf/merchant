/**
 * API key management integration tests.
 *
 * Covers:
 *   - Create a public key, use it on a public route, revoke it, verify 401.
 *   - List keys: never contains key_hash or full keys.
 *   - Deleting the last admin key → 409.
 *   - Unknown id → 404.
 *   - Public key calling POST /v1/keys → 403.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { authedFetch, jsonBody, type SeedResult, seedStore } from './helpers';

let seed: SeedResult;

beforeAll(async () => {
  seed = await seedStore();
});

interface ApiKeyItem {
  id: string;
  key_prefix: string;
  role: string;
  created_at: string;
}

interface CreateApiKeyResult {
  id: string;
  key: string;
  key_prefix: string;
  role: string;
  created_at: string;
}

describe('API key management', () => {
  it('GET /v1/keys returns a list with at least the seeded keys and no key_hash', async () => {
    const res = await authedFetch('/v1/keys', seed.sk);
    expect(res.status).toBe(200);
    const body = await jsonBody<{ items: ApiKeyItem[] }>(res);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(2);

    for (const item of body.items) {
      // Must have expected fields
      expect(item.id).toBeDefined();
      expect(item.key_prefix).toBeDefined();
      expect(item.role).toBeDefined();
      expect(item.created_at).toBeDefined();
      // Must NEVER expose key_hash or a raw key
      expect((item as any).key_hash).toBeUndefined();
      expect((item as any).key).toBeUndefined();
    }
  });

  it('POST /v1/keys with role=public creates a key and returns it once', async () => {
    const res = await authedFetch('/v1/keys', seed.sk, {
      method: 'POST',
      body: JSON.stringify({ role: 'public' }),
    });
    expect(res.status).toBe(201);
    const body = await jsonBody<CreateApiKeyResult>(res);
    expect(body.id).toBeDefined();
    expect(body.role).toBe('public');
    expect(body.key).toBeDefined();
    expect(body.key.startsWith('pk_')).toBe(true);
    expect(body.key_prefix).toBe(`${body.key.slice(0, 8)}...`);
  });

  it('created public key works on a public route', async () => {
    const createRes = await authedFetch('/v1/keys', seed.sk, {
      method: 'POST',
      body: JSON.stringify({ role: 'public' }),
    });
    const { key } = await jsonBody<CreateApiKeyResult>(createRes);

    // POST /v1/carts is a public-accessible route
    const cartRes = await authedFetch('/v1/carts', key, {
      method: 'POST',
      body: JSON.stringify({ customer_email: 'keystest@example.com' }),
    });
    expect(cartRes.status).toBe(200);
  });

  it('revoking a public key causes subsequent requests to return 401', async () => {
    const createRes = await authedFetch('/v1/keys', seed.sk, {
      method: 'POST',
      body: JSON.stringify({ role: 'public' }),
    });
    const { key, id } = await jsonBody<CreateApiKeyResult>(createRes);

    // Use the key once — should succeed
    const beforeRevoke = await authedFetch('/v1/carts', key, {
      method: 'POST',
      body: JSON.stringify({ customer_email: 'before@example.com' }),
    });
    expect(beforeRevoke.status).toBe(200);

    // Revoke
    const deleteRes = await authedFetch(`/v1/keys/${id}`, seed.sk, { method: 'DELETE' });
    expect(deleteRes.status).toBe(200);
    const delBody = await jsonBody<{ deleted: boolean }>(deleteRes);
    expect(delBody.deleted).toBe(true);

    // Now the revoked key should be rejected
    const afterRevoke = await authedFetch('/v1/carts', key, {
      method: 'POST',
      body: JSON.stringify({ customer_email: 'after@example.com' }),
    });
    expect(afterRevoke.status).toBe(401);
  });

  it('deleting an unknown id returns 404', async () => {
    const res = await authedFetch('/v1/keys/00000000-0000-0000-0000-000000000000', seed.sk, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('not_found');
  });

  it('deleting a non-last admin key is allowed', async () => {
    // Create a second admin key
    const createRes = await authedFetch('/v1/keys', seed.sk, {
      method: 'POST',
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(createRes.status).toBe(201);
    const { id: secondAdminId } = await jsonBody<CreateApiKeyResult>(createRes);

    // Delete the second admin key — should succeed (seed admin key remains)
    const deleteRes = await authedFetch(`/v1/keys/${secondAdminId}`, seed.sk, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
  });

  it('deleting the last admin key returns 409', async () => {
    // Create two fresh admin keys — we will delete both to test the guard.
    // seed.sk is intentionally left untouched so later tests keep working.
    const createA = await authedFetch('/v1/keys', seed.sk, {
      method: 'POST',
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(createA.status).toBe(201);
    const { id: idA } = await jsonBody<CreateApiKeyResult>(createA);

    const createB = await authedFetch('/v1/keys', seed.sk, {
      method: 'POST',
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(createB.status).toBe(201);
    const { id: idB } = await jsonBody<CreateApiKeyResult>(createB);

    // Delete A while B (and seed.sk) still exist → should succeed
    const del1 = await authedFetch(`/v1/keys/${idA}`, seed.sk, { method: 'DELETE' });
    expect(del1.status).toBe(200);

    // Delete B while seed.sk still exists → should succeed
    const del2 = await authedFetch(`/v1/keys/${idB}`, seed.sk, { method: 'DELETE' });
    expect(del2.status).toBe(200);

    // Now only seed.sk remains as an admin key.
    const listRes = await authedFetch('/v1/keys', seed.sk);
    const { items } = await jsonBody<{ items: ApiKeyItem[] }>(listRes);
    const adminKeys = items.filter((k) => k.role === 'admin');
    expect(adminKeys.length).toBe(1);

    // Create key C to use as the caller after seed.sk is deleted.
    const createC = await authedFetch('/v1/keys', seed.sk, {
      method: 'POST',
      body: JSON.stringify({ role: 'admin' }),
    });
    const { key: keyC, id: idC } = await jsonBody<CreateApiKeyResult>(createC);

    // Delete seed.sk (2 admin keys exist: seed.sk + C) — should succeed.
    const seedAdminId = adminKeys[0].id;
    const del3 = await authedFetch(`/v1/keys/${seedAdminId}`, keyC, { method: 'DELETE' });
    expect(del3.status).toBe(200);

    // keyC is now the sole admin key — deleting it must return 409.
    const del4 = await authedFetch(`/v1/keys/${idC}`, keyC, { method: 'DELETE' });
    expect(del4.status).toBe(409);
    const body = await jsonBody<{ error: { code: string; message: string } }>(del4);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toContain('last admin key');

    // Patch seed.sk so subsequent tests in this file can continue authenticating.
    seed.sk = keyC;
  });

  it('public key calling POST /v1/keys returns 403', async () => {
    const res = await authedFetch('/v1/keys', seed.pk, {
      method: 'POST',
      body: JSON.stringify({ role: 'public' }),
    });
    expect(res.status).toBe(403);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('forbidden');
  });

  it('public key calling GET /v1/keys returns 403', async () => {
    const res = await authedFetch('/v1/keys', seed.pk);
    expect(res.status).toBe(403);
  });

  it('POST /v1/keys with role=admin creates an sk_ prefixed key', async () => {
    const res = await authedFetch('/v1/keys', seed.sk, {
      method: 'POST',
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(res.status).toBe(201);
    const body = await jsonBody<CreateApiKeyResult>(res);
    expect(body.role).toBe('admin');
    expect(body.key.startsWith('sk_')).toBe(true);
    expect(body.key_prefix).toBe(`${body.key.slice(0, 8)}...`);
  });
});
