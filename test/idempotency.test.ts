/**
 * Idempotency-Key integration tests (merchant-466).
 *
 * Covers:
 *  (a) Replay — same key + same body → identical cart id, second response has
 *      Idempotency-Replayed: true, only one cart row in DB.
 *  (b) Conflict — same key, different body → 409 idempotency_conflict.
 *  (c) Different keys → different carts (no interference).
 *  (d) No header → normal cart creation (no idempotency processing).
 *  (e) Pruning — backdated idempotency_key row is deleted by pruneOldData;
 *      recent row survives.
 */

import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MerchantDO } from '../src/do';
import { jsonBody, type SeedResult, seedStore } from './helpers';

let seed: SeedResult;

function getMerchantStub() {
  const e = env as { MERCHANT: DurableObjectNamespace<MerchantDO> };
  const doId = e.MERCHANT.idFromName('default');
  return e.MERCHANT.get(doId);
}

beforeAll(async () => {
  seed = await seedStore();
});

// ─── helpers ────────────────────────────────────────────────────────────────

async function createCartWithKey(
  key: string,
  idempotencyKey: string | null,
  email = 'idem@example.com',
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  };
  if (idempotencyKey !== null) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  return SELF.fetch('http://example.com/v1/carts', {
    method: 'POST',
    headers,
    body: JSON.stringify({ customer_email: email }),
  });
}

// ─── (a) Replay ─────────────────────────────────────────────────────────────

describe('Replay: same key + same body', () => {
  it('returns identical cart id on second call and sets Idempotency-Replayed header', async () => {
    const iKey = `idem-replay-${crypto.randomUUID()}`;

    const r1 = await createCartWithKey(seed.pk, iKey);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('Idempotency-Replayed')).toBeNull();
    const body1 = await jsonBody<{ id: string }>(r1);

    const r2 = await createCartWithKey(seed.pk, iKey);
    expect(r2.status).toBe(200);
    expect(r2.headers.get('Idempotency-Replayed')).toBe('true');
    const body2 = await jsonBody<{ id: string }>(r2);

    expect(body2.id).toBe(body1.id);
  });

  it('only inserts one cart row in the DB', async () => {
    const iKey = `idem-onerow-${crypto.randomUUID()}`;
    const email = `onerow-${crypto.randomUUID()}@example.com`;

    await createCartWithKey(seed.pk, iKey, email);
    await createCartWithKey(seed.pk, iKey, email);

    const stub = getMerchantStub();
    const count = await runInDurableObject(stub, (instance: MerchantDO) => {
      const rows = instance.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM carts WHERE customer_email = ?`,
        [email],
      );
      return rows[0]?.count ?? 0;
    });

    expect(count).toBe(1);
  });
});

// ─── (b) Conflict ───────────────────────────────────────────────────────────

describe('Conflict: same key, different body', () => {
  it('returns 409 idempotency_conflict when body differs', async () => {
    const iKey = `idem-conflict-${crypto.randomUUID()}`;

    // First call with email A
    const r1 = await createCartWithKey(seed.pk, iKey, 'email-a@example.com');
    expect(r1.status).toBe(200);

    // Second call with same key but different email (different body)
    const r2 = await createCartWithKey(seed.pk, iKey, 'email-b@example.com');
    expect(r2.status).toBe(409);

    const body = await jsonBody<{ error: { code: string } }>(r2);
    expect(body.error.code).toBe('idempotency_conflict');
  });
});

// ─── (c) Different keys → different carts ───────────────────────────────────

describe('Different Idempotency-Keys', () => {
  it('creates distinct carts for distinct keys', async () => {
    const email = `diff-keys-${crypto.randomUUID()}@example.com`;

    const r1 = await createCartWithKey(seed.pk, `key-alpha-${crypto.randomUUID()}`, email);
    const r2 = await createCartWithKey(seed.pk, `key-beta-${crypto.randomUUID()}`, email);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const b1 = await jsonBody<{ id: string }>(r1);
    const b2 = await jsonBody<{ id: string }>(r2);

    expect(b1.id).not.toBe(b2.id);
  });
});

// ─── (d) No header → normal behavior ────────────────────────────────────────

describe('No Idempotency-Key header', () => {
  it('creates a fresh cart on each call (no deduplication)', async () => {
    const email = `no-idem-${crypto.randomUUID()}@example.com`;

    const r1 = await createCartWithKey(seed.pk, null, email);
    const r2 = await createCartWithKey(seed.pk, null, email);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const b1 = await jsonBody<{ id: string }>(r1);
    const b2 = await jsonBody<{ id: string }>(r2);

    expect(b1.id).not.toBe(b2.id);
  });
});

// ─── (e) Pruning ─────────────────────────────────────────────────────────────

describe('pruneOldData: idempotency_keys', () => {
  it('deletes rows older than 24h and keeps recent rows', async () => {
    const stub = getMerchantStub();

    const oldKeyHash = `old_${crypto.randomUUID()}`;
    const recentKeyHash = `recent_${crypto.randomUUID()}`;

    // Use SQLite datetime format (space separator, no T/Z/ms) to match what
    // DEFAULT (datetime('now')) produces so the pruning comparison works.
    function toSqliteDateTime(d: Date): string {
      return d
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, '');
    }

    const oldTime = toSqliteDateTime(new Date(Date.now() - 25 * 60 * 60 * 1000)); // 25 hours ago
    const recentTime = toSqliteDateTime(new Date(Date.now() - 1 * 60 * 60 * 1000)); // 1 hour ago

    await runInDurableObject(stub, (instance: MerchantDO) => {
      instance.run(
        `INSERT INTO idempotency_keys (key_hash, endpoint, request_hash, response_status, response_body, created_at)
         VALUES (?, 'POST /v1/carts', 'reqhash1', 200, '{"id":"cart1"}', ?)`,
        [oldKeyHash, oldTime],
      );
      instance.run(
        `INSERT INTO idempotency_keys (key_hash, endpoint, request_hash, response_status, response_body, created_at)
         VALUES (?, 'POST /v1/carts', 'reqhash2', 200, '{"id":"cart2"}', ?)`,
        [recentKeyHash, recentTime],
      );
    });

    // Verify both rows exist before pruning
    const before = await runInDurableObject(stub, (instance: MerchantDO) => {
      return instance.query<{ key_hash: string }>(
        `SELECT key_hash FROM idempotency_keys WHERE key_hash IN (?, ?)`,
        [oldKeyHash, recentKeyHash],
      );
    });
    expect(before).toHaveLength(2);

    // Run pruning
    const pruned = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.pruneOldData();
    });
    expect(pruned.idempotencyKeys).toBeGreaterThanOrEqual(1);

    // Old row should be gone; recent row should survive
    const after = await runInDurableObject(stub, (instance: MerchantDO) => {
      return instance.query<{ key_hash: string }>(
        `SELECT key_hash FROM idempotency_keys WHERE key_hash IN (?, ?)`,
        [oldKeyHash, recentKeyHash],
      );
    });

    const remaining = after.map((r) => r.key_hash);
    expect(remaining).not.toContain(oldKeyHash);
    expect(remaining).toContain(recentKeyHash);
  });
});
