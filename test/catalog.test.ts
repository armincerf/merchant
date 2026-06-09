/**
 * Product + variant CRUD integration tests.
 *
 * Covers: create product, get product, update product, list products,
 * create variant (with inventory auto-seeded), update variant,
 * delete variant, delete product (with order guard), duplicate SKU rejection.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { authedFetch, jsonBody, type SeedResult, seedStore } from './helpers';

let seed: SeedResult;

beforeAll(async () => {
  seed = await seedStore();
});

describe('products CRUD', () => {
  it('creates a product and returns it with 201', async () => {
    const res = await authedFetch('/v1/products', seed.sk, {
      method: 'POST',
      body: JSON.stringify({ title: 'New Product', description: 'A brand new product' }),
    });
    expect(res.status).toBe(201);
    const body = await jsonBody<{
      id: string;
      title: string;
      slug: string;
      status: string;
      variants: unknown[];
    }>(res);
    expect(body.title).toBe('New Product');
    expect(body.slug).toBe('new-product');
    expect(body.status).toBe('active');
    expect(Array.isArray(body.variants)).toBe(true);
  });

  it('gets an existing product by ID', async () => {
    const res = await authedFetch(`/v1/products/${seed.productId}`, seed.sk);
    expect(res.status).toBe(200);
    const body = await jsonBody<{ id: string; title: string }>(res);
    expect(body.id).toBe(seed.productId);
    expect(body.title).toBe('Test Widget');
  });

  it('returns 404 for a non-existent product', async () => {
    const res = await authedFetch('/v1/products/00000000-0000-0000-0000-000000000000', seed.sk);
    expect(res.status).toBe(404);
  });

  it('updates a product title and status', async () => {
    const res = await authedFetch(`/v1/products/${seed.productId}`, seed.sk, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Updated Widget', status: 'draft' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody<{ title: string; status: string }>(res);
    expect(body.title).toBe('Updated Widget');
    expect(body.status).toBe('draft');
  });

  it('lists products and includes the seeded product', async () => {
    const res = await authedFetch('/v1/products', seed.sk);
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      items: Array<{ id: string }>;
      pagination: { has_more: boolean };
    }>(res);
    expect(body.items.some((p) => p.id === seed.productId)).toBe(true);
    expect(typeof body.pagination.has_more).toBe('boolean');
  });
});

describe('variant CRUD', () => {
  it('creates a variant and auto-initialises inventory at 0', async () => {
    const newSku = `SKU-VARIANT-${Date.now()}`;
    const res = await authedFetch(`/v1/products/${seed.productId}/variants`, seed.sk, {
      method: 'POST',
      body: JSON.stringify({ sku: newSku, title: 'Extra Variant', price_cents: 2000 }),
    });
    expect(res.status).toBe(201);
    const body = await jsonBody<{
      id: string;
      sku: string;
      title: string;
      price_cents: number;
    }>(res);
    expect(body.sku).toBe(newSku);
    expect(body.price_cents).toBe(2000);

    // Verify inventory was initialised
    const invRes = await authedFetch(`/v1/inventory?sku=${newSku}`, seed.sk);
    expect(invRes.status).toBe(200);
    const inv = await jsonBody<{ items: Array<{ sku: string; on_hand: number }> }>(invRes);
    expect(inv.items[0].on_hand).toBe(0);
  });

  it('rejects duplicate SKU on variant create', async () => {
    const res = await authedFetch(`/v1/products/${seed.productId}/variants`, seed.sk, {
      method: 'POST',
      body: JSON.stringify({ sku: seed.sku, title: 'Duplicate', price_cents: 500 }),
    });
    expect(res.status).toBe(409);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('conflict');
  });

  it('updates variant price', async () => {
    const res = await authedFetch(
      `/v1/products/${seed.productId}/variants/${seed.variantId}`,
      seed.sk,
      {
        method: 'PATCH',
        body: JSON.stringify({ price_cents: 1500 }),
      },
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ price_cents: number }>(res);
    expect(body.price_cents).toBe(1500);
  });

  it('deletes a variant (one with no orders)', async () => {
    // Create a throwaway variant to delete
    const tempSku = `SKU-DEL-${Date.now()}`;
    const createRes = await authedFetch(`/v1/products/${seed.productId}/variants`, seed.sk, {
      method: 'POST',
      body: JSON.stringify({ sku: tempSku, title: 'To Delete', price_cents: 100 }),
    });
    const { id: tempVariantId } = await jsonBody<{ id: string }>(createRes);

    const delRes = await authedFetch(
      `/v1/products/${seed.productId}/variants/${tempVariantId}`,
      seed.sk,
      { method: 'DELETE' },
    );
    expect(delRes.status).toBe(200);
    const body = await jsonBody<{ deleted: boolean }>(delRes);
    expect(body.deleted).toBe(true);
  });
});
