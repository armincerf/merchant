/**
 * UCP hardening integration tests (merchant-f3l).
 *
 * Covers:
 *  (a) POST /ucp/v1/checkout-sessions without auth → 401; with pk key → 201
 *  (b) GET /.well-known/ucp without auth → 200
 *  (c) complete endpoint with javascript: success_url → 400
 *      (URL validation runs before Stripe, so no Stripe config needed)
 *  (d) ucpFinalizeOrder idempotency — call twice with same stripe session id → one order
 *  (e) cron cancels expired UCP sessions
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MerchantDO } from '../src/do';
import { anonFetch, authedFetch, jsonBody, type SeedResult, seedStore } from './helpers';

let seed: SeedResult;

function getMerchantStub() {
  const e = env as { MERCHANT: DurableObjectNamespace<MerchantDO> };
  const doId = e.MERCHANT.idFromName('default');
  return e.MERCHANT.get(doId);
}

beforeAll(async () => {
  seed = await seedStore();
});

// ── (a) Auth on /ucp/v1/* ────────────────────────────────────────────────────

describe('UCP auth', () => {
  it('(a) returns 401 for unauthenticated POST /ucp/v1/checkout-sessions', async () => {
    const res = await anonFetch('/ucp/v1/checkout-sessions', {
      method: 'POST',
      body: JSON.stringify({
        currency: 'USD',
        line_items: [{ item: { id: seed.sku }, quantity: 1 }],
      }),
    });
    expect(res.status).toBe(401);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe('unauthorized');
  });

  it('(a) returns 201 for authenticated POST /ucp/v1/checkout-sessions with pk key', async () => {
    const res = await authedFetch('/ucp/v1/checkout-sessions', seed.pk, {
      method: 'POST',
      body: JSON.stringify({
        currency: 'USD',
        line_items: [{ item: { id: seed.sku }, quantity: 1 }],
      }),
    });
    expect(res.status).toBe(201);
    const body = await jsonBody<{ id: string; status: string }>(res);
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });
});

// ── (b) /.well-known/ucp stays public ────────────────────────────────────────

describe('UCP discovery endpoint', () => {
  it('(b) GET /.well-known/ucp returns 200 without authentication', async () => {
    const res = await anonFetch('/.well-known/ucp');
    expect(res.status).toBe(200);
    const body = await jsonBody<{ ucp: unknown }>(res);
    expect(body.ucp).toBeDefined();
  });
});

// ── (c) URL validation in complete endpoint ───────────────────────────────────

describe('UCP complete URL validation', () => {
  it('(c) rejects javascript: success_url with 400', async () => {
    // Create a session in ready_for_complete state
    const createRes = await authedFetch('/ucp/v1/checkout-sessions', seed.pk, {
      method: 'POST',
      body: JSON.stringify({
        currency: 'USD',
        line_items: [{ item: { id: seed.sku }, quantity: 1 }],
      }),
    });
    expect(createRes.status).toBe(201);
    const session = await jsonBody<{ id: string; status: string }>(createRes);
    expect(session.status).toBe('ready_for_complete');

    // Try to complete with a javascript: success_url
    // URL validation runs BEFORE Stripe, so this always 400s regardless of Stripe config.
    const completeRes = await authedFetch(
      `/ucp/v1/checkout-sessions/${session.id}/complete`,
      seed.pk,
      {
        method: 'POST',
        body: JSON.stringify({
          payment_data: {
            handler_id: 'stripe_checkout',
            success_url: 'javascript:alert(1)',
            cancel_url: 'https://example.com/cancel',
          },
        }),
      },
    );
    expect(completeRes.status).toBe(400);
    const body = await jsonBody<{ error: { code: string; message: string } }>(completeRes);
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toMatch(/success_url/i);
  });

  it('(c) rejects javascript: cancel_url with 400', async () => {
    const createRes = await authedFetch('/ucp/v1/checkout-sessions', seed.pk, {
      method: 'POST',
      body: JSON.stringify({
        currency: 'USD',
        line_items: [{ item: { id: seed.sku }, quantity: 1 }],
      }),
    });
    const session = await jsonBody<{ id: string }>(createRes);

    const completeRes = await authedFetch(
      `/ucp/v1/checkout-sessions/${session.id}/complete`,
      seed.pk,
      {
        method: 'POST',
        body: JSON.stringify({
          payment_data: {
            handler_id: 'stripe_checkout',
            success_url: 'https://example.com/success',
            cancel_url: 'javascript:void(0)',
          },
        }),
      },
    );
    expect(completeRes.status).toBe(400);
    const body = await jsonBody<{ error: { code: string; message: string } }>(completeRes);
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toMatch(/cancel_url/i);
  });
});

// ── (d) ucpFinalizeOrder idempotency ─────────────────────────────────────────

describe('ucpFinalizeOrder idempotency', () => {
  it('(d) calling twice with same stripe session id creates exactly one order', async () => {
    const stub = getMerchantStub();

    // Insert a UCP checkout session directly via runInDurableObject
    const ucpSessionId = crypto.randomUUID();
    const stripeSessionId = `cs_test_ucp_idem_${Date.now()}`;
    const lineItemsJson = JSON.stringify([
      {
        id: crypto.randomUUID(),
        item: { id: seed.sku, title: 'Test Widget' },
        quantity: 1,
        unit_price: { amount: 1000, currency: 'USD' },
        total_price: { amount: 1000, currency: 'USD' },
      },
    ]);
    const totalsJson = JSON.stringify([
      { type: 'subtotal', amount: 1000, currency: 'USD' },
      { type: 'grand_total', amount: 1000, currency: 'USD' },
    ]);
    const buyerJson = JSON.stringify({ email: 'ucp-idem@example.com' });
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();

    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.run(
        `INSERT INTO ucp_checkout_sessions (id, status, currency, line_items, buyer, totals, messages, stripe_session_id, expires_at, created_at, updated_at)
         VALUES (?, 'complete_in_progress', 'USD', ?, ?, ?, '[]', ?, ?, datetime('now'), datetime('now'))`,
        [ucpSessionId, lineItemsJson, buyerJson, totalsJson, stripeSessionId, expiresAt],
      );
    });

    // First call
    const first = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.ucpFinalizeOrder({
        ucpSessionId,
        stripeSessionId,
        stripePaymentIntent: null,
      });
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unexpected');
    const firstOrderId = first.orderId;
    expect(firstOrderId).toBeTruthy();
    expect(first.orderNumber).toMatch(/^ORD-/);

    // Second call — must be idempotent
    const second = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.ucpFinalizeOrder({
        ucpSessionId,
        stripeSessionId,
        stripePaymentIntent: null,
      });
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unexpected');
    expect(second.orderId).toBe(firstOrderId);

    // Exactly one order for this stripe session
    const orderCount = await runInDurableObject(stub, async (instance: MerchantDO) => {
      const rows = instance.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM orders WHERE stripe_checkout_session_id = ?`,
        [stripeSessionId],
      );
      return rows[0]?.count ?? 0;
    });
    expect(orderCount).toBe(1);
  });
});

// ── (e) cron cancels expired UCP sessions ────────────────────────────────────

describe('cleanupExpiredCarts cancels expired UCP sessions', () => {
  it('(e) expired ucp_checkout_session is canceled after cleanup', async () => {
    const stub = getMerchantStub();

    const ucpSessionId = crypto.randomUUID();
    const pastExpiry = new Date(Date.now() - 1000).toISOString(); // already expired

    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.run(
        `INSERT INTO ucp_checkout_sessions (id, status, currency, line_items, buyer, totals, messages, expires_at, created_at, updated_at)
         VALUES (?, 'ready_for_complete', 'USD', '[]', 'null', '[]', '[]', ?, datetime('now'), datetime('now'))`,
        [ucpSessionId, pastExpiry],
      );
    });

    // Confirm it's in ready_for_complete before cleanup
    const beforeStatus = await runInDurableObject(stub, async (instance: MerchantDO) => {
      const [row] = instance.query<{ status: string }>(
        `SELECT status FROM ucp_checkout_sessions WHERE id = ?`,
        [ucpSessionId],
      );
      return row?.status;
    });
    expect(beforeStatus).toBe('ready_for_complete');

    // Run cleanup
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      await instance.cleanupExpiredCarts();
    });

    // Confirm it's now canceled
    const afterStatus = await runInDurableObject(stub, async (instance: MerchantDO) => {
      const [row] = instance.query<{ status: string }>(
        `SELECT status FROM ucp_checkout_sessions WHERE id = ?`,
        [ucpSessionId],
      );
      return row?.status;
    });
    expect(afterStatus).toBe('canceled');
  });
});
