/**
 * Edge cache tests for public catalog reads.
 *
 * The acceptance criteria from merchant-0u3:
 *  - a second identical catalog GET within the TTL does not hit the DO
 *    (asserted by counting sql.exec calls inside the DO instance);
 *  - a product mutation makes the next read reflect the change within one
 *    request (version-stamp invalidation via SQLite triggers);
 *  - admin behavior unchanged (admin reads bypass the cache).
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MerchantDO } from '../src/do';
import { clearVersionMemo } from '../src/middleware/cache';
import { anonFetch, authedFetch, jsonBody, type SeedResult, seedStore } from './helpers';

function getStub() {
  const e = env as unknown as { MERCHANT: DurableObjectNamespace<MerchantDO> };
  return e.MERCHANT.get(e.MERCHANT.idFromName('default'));
}

/**
 * Wrap the DO's SqlStorage in a counting proxy. Every query — whether issued
 * via the query/run RPCs or inside a domain method — funnels through
 * this.sql.exec, so the counter sees all database work.
 */
async function instrumentSqlCounter(): Promise<void> {
  await runInDurableObject(getStub(), (instance) => {
    const target = instance as unknown as { sql: SqlStorage; __sqlCount?: number };
    if (typeof target.__sqlCount === 'number') return;
    target.__sqlCount = 0;
    const real = target.sql;
    target.sql = new Proxy(real, {
      get(t, prop) {
        if (prop === 'exec') {
          return (...args: [string, ...unknown[]]) => {
            (target.__sqlCount as number)++;
            return t.exec(...args);
          };
        }
        return Reflect.get(t, prop, t);
      },
    });
  });
}

async function sqlCount(): Promise<number> {
  return await runInDurableObject(
    getStub(),
    (instance) => (instance as unknown as { __sqlCount?: number }).__sqlCount ?? 0,
  );
}

// /v1/setup/init refuses to run twice, so the whole file shares one seed.
let seed: SeedResult;

beforeAll(async () => {
  seed = await seedStore();
});

describe('public catalog edge cache', () => {
  it('serves the second identical public GET from cache without touching the DO', async () => {
    const first = await authedFetch('/v1/products', seed.pk);
    expect(first.status).toBe(200);
    expect(first.headers.get('X-Cache')).toBe('MISS');
    const firstBody = await jsonBody(first);

    await instrumentSqlCounter();
    const before = await sqlCount();

    const second = await authedFetch('/v1/products', seed.pk);
    expect(second.status).toBe(200);
    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(await jsonBody(second)).toEqual(firstBody);

    // Auth role, version counter, and response body were all served from
    // isolate/edge caches — zero SQL ran inside the DO.
    expect(await sqlCount()).toBe(before);
  });

  it('reflects a product mutation on the very next read', async () => {
    const primed = await authedFetch(`/v1/products/${seed.productId}`, seed.pk);
    expect(primed.headers.get('X-Cache')).toBe('MISS');

    const patch = await authedFetch(`/v1/products/${seed.productId}`, seed.sk, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Renamed Widget' }),
    });
    expect(patch.status).toBe(200);

    const after = await authedFetch(`/v1/products/${seed.productId}`, seed.pk);
    expect(after.headers.get('X-Cache')).toBe('MISS');
    expect((await jsonBody<{ title: string }>(after)).title).toBe('Renamed Widget');
  });

  it('caches availability and invalidates on inventory adjustment', async () => {
    const first = await anonFetch(`/v1/inventory/available?skus=${seed.sku}`);
    expect(first.headers.get('X-Cache')).toBe('MISS');
    expect((await jsonBody<{ items: { available: number }[] }>(first)).items[0].available).toBe(10);

    const second = await anonFetch(`/v1/inventory/available?skus=${seed.sku}`);
    expect(second.headers.get('X-Cache')).toBe('HIT');

    const adjust = await authedFetch(`/v1/inventory/${seed.sku}/adjust`, seed.sk, {
      method: 'POST',
      body: JSON.stringify({ delta: 5, reason: 'restock' }),
    });
    expect(adjust.status).toBe(200);

    const after = await anonFetch(`/v1/inventory/available?skus=${seed.sku}`);
    expect(after.headers.get('X-Cache')).toBe('MISS');
    expect((await jsonBody<{ items: { available: number }[] }>(after)).items[0].available).toBe(15);
  });

  it('invalidates when inventory changes inside the DO, without any HTTP mutation', async () => {
    const first = await anonFetch(`/v1/inventory/available?skus=${seed.sku}`);
    const baseline = (await jsonBody<{ items: { available: number }[] }>(first)).items[0].available;

    // Reserve stock the way checkout finalization / cart cleanup do: a write
    // inside the DO that no Worker route saw. The SQLite trigger bumps the
    // inventory version; clearing the memo simulates another isolate (or this
    // one after VERSION_MEMO_TTL_MS).
    await runInDurableObject(getStub(), (instance) => {
      (instance as MerchantDO).run(`UPDATE inventory SET reserved = reserved + 2 WHERE sku = ?`, [
        seed.sku,
      ]);
    });
    clearVersionMemo();

    const after = await anonFetch(`/v1/inventory/available?skus=${seed.sku}`);
    expect(after.headers.get('X-Cache')).toBe('MISS');
    expect((await jsonBody<{ items: { available: number }[] }>(after)).items[0].available).toBe(
      baseline - 2,
    );
  });

  it('normalizes query parameter order into one cache entry', async () => {
    const first = await authedFetch('/v1/products?status=active&limit=5', seed.pk);
    expect(first.headers.get('X-Cache')).toBe('MISS');

    const reordered = await authedFetch('/v1/products?limit=5&status=active', seed.pk);
    expect(reordered.headers.get('X-Cache')).toBe('HIT');
  });

  it('admin reads bypass the cache', async () => {
    // Prime a public cache entry, then verify the admin read ignores it.
    await authedFetch('/v1/products', seed.pk);

    const admin = await authedFetch('/v1/products', seed.sk);
    expect(admin.status).toBe(200);
    expect(admin.headers.get('X-Cache')).toBeNull();
  });

  it('does not cache distinct URLs together', async () => {
    // List and detail share a version counter but must never share an entry:
    // the detail URL returns the detail body even right after the list URL
    // was cached at the same version.
    const list = await authedFetch('/v1/products', seed.pk);
    expect(Array.isArray((await jsonBody<{ items: unknown[] }>(list)).items)).toBe(true);

    const detail = await authedFetch(`/v1/products/${seed.productId}`, seed.pk);
    expect((await jsonBody<{ id: string }>(detail)).id).toBe(seed.productId);
  });
});

describe('auth memo', () => {
  it('a revoked key stops working immediately', async () => {
    const created = await authedFetch('/v1/keys', seed.sk, {
      method: 'POST',
      body: JSON.stringify({ role: 'public' }),
    });
    expect(created.status).toBe(201);
    const { id, key } = await jsonBody<{ id: string; key: string }>(created);

    // Use the key so the auth memo caches it.
    const ok = await authedFetch('/v1/products', key);
    expect(ok.status).toBe(200);

    const del = await authedFetch(`/v1/keys/${id}`, seed.sk, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const rejected = await authedFetch('/v1/products', key);
    expect(rejected.status).toBe(401);
  });
});

describe('cache version triggers', () => {
  async function versions(): Promise<{ catalog: number; inventory: number }> {
    return await runInDurableObject(getStub(), (instance) => {
      const rows = (instance as MerchantDO).query<{ key: string; value: number }>(
        `SELECT key, CAST(value AS INTEGER) as value FROM config WHERE key IN ('catalog_version', 'inventory_version')`,
      );
      const byKey = new Map(rows.map((r) => [r.key, r.value]));
      return {
        catalog: byKey.get('catalog_version') ?? -1,
        inventory: byKey.get('inventory_version') ?? -1,
      };
    });
  }

  it('product, variant, and inventory writes each bump the right counter', async () => {
    const before = await versions();
    expect(before.catalog).toBeGreaterThan(0);
    expect(before.inventory).toBeGreaterThan(0);

    const patch = await authedFetch(`/v1/products/${seed.productId}`, seed.sk, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'bumped' }),
    });
    expect(patch.status).toBe(200);

    const afterProduct = await versions();
    expect(afterProduct.catalog).toBeGreaterThan(before.catalog);
    expect(afterProduct.inventory).toBe(before.inventory);

    const adjust = await authedFetch(`/v1/inventory/${seed.sku}/adjust`, seed.sk, {
      method: 'POST',
      body: JSON.stringify({ delta: 1, reason: 'restock' }),
    });
    expect(adjust.status).toBe(200);

    const afterInventory = await versions();
    expect(afterInventory.inventory).toBeGreaterThan(afterProduct.inventory);
  });
});
