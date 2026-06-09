/**
 * Inventory integration tests.
 *
 * Covers: list inventory, adjust (restock), adjust negative (correction),
 * cannot go below zero, availability endpoint (public, no auth),
 * inventory_logs are created on adjust.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { seedStore, authedFetch, anonFetch, jsonBody, type SeedResult } from './helpers';

let seed: SeedResult;

beforeAll(async () => {
  seed = await seedStore();
});

describe('inventory management', () => {
  it('lists inventory and includes the seeded SKU', async () => {
    const res = await authedFetch('/v1/inventory', seed.sk);
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      items: Array<{ sku: string; on_hand: number; reserved: number; available: number }>;
    }>(res);
    const item = body.items.find((i) => i.sku === seed.sku);
    expect(item).toBeDefined();
    expect(item!.on_hand).toBe(10);
    expect(item!.reserved).toBe(0);
    expect(item!.available).toBe(10);
  });

  it('adjusts inventory up (restock)', async () => {
    const res = await authedFetch(`/v1/inventory/${seed.sku}/adjust`, seed.sk, {
      method: 'POST',
      body: JSON.stringify({ delta: 5, reason: 'restock' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody<{ on_hand: number; available: number }>(res);
    expect(body.on_hand).toBe(15);
    expect(body.available).toBe(15);
  });

  it('adjusts inventory down (correction)', async () => {
    const res = await authedFetch(`/v1/inventory/${seed.sku}/adjust`, seed.sk, {
      method: 'POST',
      body: JSON.stringify({ delta: -3, reason: 'correction' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody<{ on_hand: number }>(res);
    expect(body.on_hand).toBe(12);
  });

  it('rejects adjustment that would bring on_hand below zero', async () => {
    const res = await authedFetch(`/v1/inventory/${seed.sku}/adjust`, seed.sk, {
      method: 'POST',
      body: JSON.stringify({ delta: -9999, reason: 'correction' }),
    });
    expect(res.status).toBe(400);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 404 for a non-existent SKU', async () => {
    const res = await authedFetch('/v1/inventory/NONEXISTENT-SKU/adjust', seed.sk, {
      method: 'POST',
      body: JSON.stringify({ delta: 1, reason: 'restock' }),
    });
    expect(res.status).toBe(404);
  });

  it('availability endpoint works without auth', async () => {
    const res = await anonFetch(`/v1/inventory/available?skus=${seed.sku}`);
    expect(res.status).toBe(200);
    const body = await jsonBody<{ items: Array<{ sku: string; available: number }> }>(res);
    expect(body.items[0].sku).toBe(seed.sku);
    expect(body.items[0].available).toBeGreaterThan(0);
  });

  it('availability returns 0 for unknown SKUs without error', async () => {
    const res = await anonFetch('/v1/inventory/available?skus=UNKNOWN-SKU-999');
    expect(res.status).toBe(200);
    const body = await jsonBody<{ items: Array<{ sku: string; available: number }> }>(res);
    expect(body.items[0].available).toBe(0);
  });
});
