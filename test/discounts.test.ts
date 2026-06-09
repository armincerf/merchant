/**
 * Discount validation integration tests.
 *
 * Covers: create discount, apply to cart, expired discount rejected,
 * min_purchase_cents enforced, usage_limit enforced,
 * percentage vs fixed_amount calculation, inactive discount rejected.
 *
 * Note: Stripe sync is skipped because no STRIPE_SECRET_KEY is set in test env.
 *
 * Rate-limit note: /v1/carts is limited to 30 req/min per API key.  However, the
 * rate-limit counter is shared across ALL paths for a given key — this is a source
 * bug (documented below). Tests are designed to stay within ~28 total requests to
 * avoid hitting the counter ceiling for the /v1/carts config.
 *
 * Source bug: In src/middleware/rate-limit.ts the counter key is
 * `${identifier}:${windowStart}` which is the same for ALL path configs that share
 * the same windowMs. This means that 30 requests to ANY endpoint (e.g. /v1/discounts
 * which has a 500/min admin limit) will exhaust the /v1/carts 30/min counter, blocking
 * cart operations even if they haven't been called before.
 */

import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MerchantDO } from '../src/do';
import { authedFetch, jsonBody, type SeedResult, seedStore } from './helpers';

let seed: SeedResult;
// Shared cart used by the application suite — seeded once in beforeAll
let sharedCartId: string;

beforeAll(async () => {
  seed = await seedStore();

  // Pre-create one cart and add items so application tests can reuse it.
  // Cart subtotal: 2 × $10 = $20 (2000 cents)
  const cartRes = await authedFetch('/v1/carts', seed.sk, {
    method: 'POST',
    body: JSON.stringify({ customer_email: 'buyer@example.com' }),
  });
  const { id: cartId } = await jsonBody<{ id: string }>(cartRes);
  sharedCartId = cartId;

  await authedFetch(`/v1/carts/${sharedCartId}/items/add`, seed.sk, {
    method: 'POST',
    body: JSON.stringify({ sku: seed.sku, qty: 2 }),
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function createDiscount(overrides: Record<string, unknown> = {}): Promise<{
  id: string;
  code: string;
}> {
  const code = `D-${Date.now()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const res = await authedFetch('/v1/discounts', seed.sk, {
    method: 'POST',
    body: JSON.stringify({ code, type: 'percentage', value: 10, ...overrides }),
  });
  if (!res.ok) throw new Error(`createDiscount failed: ${res.status} ${await res.text()}`);
  return jsonBody<{ id: string; code: string }>(res);
}

async function applyToSharedCart(code: string): Promise<Response> {
  return authedFetch(`/v1/carts/${sharedCartId}/apply-discount`, seed.sk, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

async function removeFromSharedCart(): Promise<void> {
  await authedFetch(`/v1/carts/${sharedCartId}/discount`, seed.sk, { method: 'DELETE' });
}

// ── Suite: discount CRUD ─────────────────────────────────────────────────────

describe('discount CRUD', () => {
  it('creates a discount and returns 201', async () => {
    const code = `CRUD-CREATE-${Date.now()}`;
    const res = await authedFetch('/v1/discounts', seed.sk, {
      method: 'POST',
      body: JSON.stringify({ code, type: 'fixed_amount', value: 500 }),
    });
    expect(res.status).toBe(201);
    const body = await jsonBody<{
      id: string;
      code: string;
      type: string;
      value: number;
      status: string;
    }>(res);
    expect(body.code).toBe(code.toUpperCase());
    expect(body.type).toBe('fixed_amount');
    expect(body.value).toBe(500);
    expect(body.status).toBe('active');
  });

  it('rejects duplicate discount codes', async () => {
    const { code } = await createDiscount();
    const res = await authedFetch('/v1/discounts', seed.sk, {
      method: 'POST',
      body: JSON.stringify({ code, type: 'percentage', value: 5 }),
    });
    expect(res.status).toBe(409);
  });

  it('deactivates a discount via DELETE and reports inactive status', async () => {
    const { id } = await createDiscount();
    // DELETE deactivates
    const res = await authedFetch(`/v1/discounts/${id}`, seed.sk, { method: 'DELETE' });
    expect(res.status).toBe(200);
    // Verify via GET (counts toward the shared rate-limit counter)
    const getRes = await authedFetch(`/v1/discounts/${id}`, seed.sk);
    const body = await jsonBody<{ status: string }>(getRes);
    expect(body.status).toBe('inactive');
  });
});

// ── Suite: discount application ──────────────────────────────────────────────

describe('discount application to cart', () => {
  it('applies a valid percentage discount to a cart', async () => {
    const { code } = await createDiscount({ value: 10 });
    const res = await applyToSharedCart(code);
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      discount: { code: string; type: string; amount_cents: number };
      totals: { subtotal_cents: number; discount_cents: number; total_cents: number };
    }>(res);
    expect(body.discount.type).toBe('percentage');
    expect(body.totals.discount_cents).toBe(200); // 10% of 2000
    expect(body.totals.total_cents).toBe(1800);
    await removeFromSharedCart();
  });

  it('applies a fixed_amount discount to a cart', async () => {
    const { code } = await createDiscount({ type: 'fixed_amount', value: 300 });
    const res = await applyToSharedCart(code);
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      totals: { discount_cents: number; total_cents: number };
    }>(res);
    expect(body.totals.discount_cents).toBe(300);
    expect(body.totals.total_cents).toBe(1700);
    await removeFromSharedCart();
  });

  it('rejects an expired discount', async () => {
    const { code } = await createDiscount({
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await applyToSharedCart(code);
    expect(res.status).toBe(400);
    const body = await jsonBody<{ error: { message: string } }>(res);
    expect(body.error.message).toMatch(/expired/i);
  });

  it('rejects a discount that has not started yet', async () => {
    const { code } = await createDiscount({
      starts_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const res = await applyToSharedCart(code);
    expect(res.status).toBe(400);
    const body = await jsonBody<{ error: { message: string } }>(res);
    expect(body.error.message).toMatch(/not started/i);
  });

  it('enforces min_purchase_cents', async () => {
    const { code } = await createDiscount({ min_purchase_cents: 5000 }); // $50 min, cart is $20
    const res = await applyToSharedCart(code);
    expect(res.status).toBe(400);
    const body = await jsonBody<{ error: { message: string } }>(res);
    expect(body.error.message).toMatch(/minimum purchase/i);
  });

  it('rejects an inactive discount', async () => {
    const { id, code } = await createDiscount();
    await authedFetch(`/v1/discounts/${id}`, seed.sk, { method: 'DELETE' });
    const res = await applyToSharedCart(code);
    expect(res.status).toBe(400);
    const body = await jsonBody<{ error: { message: string } }>(res);
    expect(body.error.message).toMatch(/not active/i);
  });

  it('enforces usage_limit — rejects when usage_count >= usage_limit via direct DB seed', async () => {
    // The API enforces usage_limit > 0 via schema. To test the exhausted path,
    // we create a discount with usage_limit=1 then directly set usage_count=1
    // in the DO storage via runInDurableObject (bypassing the HTTP layer).
    const { id, code } = await createDiscount({ usage_limit: 1 });

    // Directly set usage_count to equal usage_limit via DO RPC
    const env = (await import('cloudflare:workers')).env as {
      MERCHANT: DurableObjectNamespace<MerchantDO>;
    };
    const doId = env.MERCHANT.idFromName('default');
    const stub = env.MERCHANT.get(doId);
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.run(`UPDATE discounts SET usage_count = usage_limit WHERE id = ?`, [id]);
    });

    const res = await applyToSharedCart(code);
    expect(res.status).toBe(400);
    const body = await jsonBody<{ error: { message: string } }>(res);
    expect(body.error.message).toMatch(/usage limit/i);
  });

  it('returns 404 when applying unknown discount code', async () => {
    const res = await applyToSharedCart('NONEXISTENT-CODE-999');
    expect(res.status).toBe(404);
  });
});
