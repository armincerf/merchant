/**
 * Tests for the expired-cart payment money path (merchant-wie).
 *
 * The bug: the Stripe Checkout Session used to outlive the cart (24h vs
 * 60min), so a customer could pay after the cron had released the cart's
 * inventory — producing a paid order with zero items and resold stock.
 *
 * Covers:
 *  - finalizeOrderFromCart refuses a released cart (cart_released) and a
 *    missing cart (cart_not_found) instead of creating an empty order
 *  - full route-level flow: checkout → cron release → late
 *    checkout.session.completed webhook → no order, automatic refund,
 *    durable payment_anomalies record, order.failed alert dispatched,
 *    event claim kept (no Stripe retry)
 *  - happy path through the refactored webhook handler still creates orders
 *  - POST /carts/{id}/checkout sends expires_at to Stripe equal to the
 *    cart's expires_at (single checkoutWindow() instant)
 *  - cron grace period: a checked_out cart just past expiry is not released
 *    immediately (lets a last-second payment's webhook win the race)
 */

import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MerchantDO } from '../src/do';
import { CHECKOUT_WINDOW_MINUTES } from '../src/lib/checkout-window';
import { setBackoffMs } from '../src/lib/webhooks';
import { authedFetch, jsonBody, type SeedResult, seedStore } from './helpers';

let seed: SeedResult;

const WEBHOOK_SECRET = 'whsec_test_secret_for_expired_cart_payment';

function getMerchantStub() {
  const e = env as { MERCHANT: DurableObjectNamespace<MerchantDO> };
  const doId = e.MERCHANT.idFromName('default');
  return e.MERCHANT.get(doId);
}

// ── Outbound fetch mocking ───────────────────────────────────────────────────
// vitest-pool-workers runs the worker in the same isolate as the tests, so
// mocking globalThis.fetch intercepts the worker's outbound Stripe calls
// (the Stripe SDK resolves to its fetch-based workerd build). Tests register
// routes keyed by "METHOD origin/path"; unmocked requests throw.

type RouteHandler = (request: Request, bodyText: string) => Response | Promise<Response>;
const fetchRoutes = new Map<string, RouteHandler>();

function mockRoute(method: string, url: string, handler: RouteHandler): void {
  fetchRoutes.set(`${method} ${url}`, handler);
}

beforeAll(async () => {
  seed = await seedStore();

  // Store Stripe config in the DO (the webhook route reads it from there).
  await runInDurableObject(getMerchantStub(), async (instance: MerchantDO) => {
    instance.run(
      `INSERT INTO config (key, value, updated_at) VALUES ('stripe', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify({ secret_key: 'sk_test_fake', webhook_secret: WEBHOOK_SECRET })],
    );
  });

  setBackoffMs(() => 0); // no real delays in outbound-webhook retries

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const handler = fetchRoutes.get(`${request.method} ${url.origin}${url.pathname}`);
    if (!handler) {
      throw new Error(`Unmocked outbound fetch: ${request.method} ${request.url}`);
    }
    // arrayBuffer + decode instead of .text() to avoid workerd's content-type warning
    const bodyText = new TextDecoder().decode(await request.arrayBuffer().catch(() => undefined));
    return handler(request, bodyText);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  setBackoffMs(null);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createCart(email: string): Promise<string> {
  const res = await authedFetch('/v1/carts', seed.pk, {
    method: 'POST',
    body: JSON.stringify({ customer_email: email }),
  });
  if (!res.ok) throw new Error(`createCart failed: ${res.status} ${await res.text()}`);
  const body = await jsonBody<{ id: string }>(res);
  return body.id;
}

async function addItem(cartId: string, sku: string, qty: number): Promise<void> {
  const res = await authedFetch(`/v1/carts/${cartId}/items/add`, seed.pk, {
    method: 'POST',
    body: JSON.stringify({ sku, qty }),
  });
  if (!res.ok) throw new Error(`addItem failed: ${res.status} ${await res.text()}`);
}

async function getInventory(
  sku: string,
): Promise<{ on_hand: number; reserved: number; available: number }> {
  const res = await authedFetch(`/v1/inventory?sku=${sku}`, seed.sk);
  const body = await jsonBody<{
    items: Array<{ on_hand: number; reserved: number; available: number }>;
  }>(res);
  return body.items[0];
}

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Compute a valid Stripe webhook signature header for `payload`. */
async function stripeSignature(payload: string, secret: string): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${payload}`));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `t=${ts},v1=${hex}`;
}

interface SessionOverrides {
  payment_intent?: string | null;
  amount_total?: number;
}

function makeSession(sessionId: string, cartId: string, email: string, o: SessionOverrides = {}) {
  return {
    id: sessionId,
    object: 'checkout.session',
    metadata: { cart_id: cartId },
    payment_intent: o.payment_intent === undefined ? `pi_${sessionId}` : o.payment_intent,
    amount_total: o.amount_total ?? 2000,
    amount_subtotal: o.amount_total ?? 2000,
    currency: 'usd',
    customer_email: email,
    customer_details: { email, name: 'Test Buyer', phone: null },
    shipping_details: null,
    total_details: { amount_tax: 0, amount_shipping: 0 },
  };
}

async function deliverCompletedWebhook(
  session: ReturnType<typeof makeSession>,
): Promise<{ response: Response; eventId: string }> {
  const eventId = uniqueId('evt');
  const body = JSON.stringify({
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: session },
  });
  const signature = await stripeSignature(body, WEBHOOK_SECRET);
  const response = await SELF.fetch('http://example.com/v1/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body,
  });
  return { response, eventId };
}

/** Drive a cart to checked_out and attach a Stripe session id, optionally backdating expiry. */
async function checkOutCart(cartId: string, sessionId: string, expiresAt?: string): Promise<void> {
  await runInDurableObject(getMerchantStub(), async (instance: MerchantDO) => {
    const result = instance.cartBeginCheckout(cartId);
    if ('code' in result) throw new Error(`cartBeginCheckout failed: ${result.code}`);
    instance.run(
      `UPDATE carts SET stripe_checkout_session_id = ?${expiresAt ? ', expires_at = ?' : ''} WHERE id = ?`,
      expiresAt ? [sessionId, expiresAt, cartId] : [sessionId, cartId],
    );
  });
}

function mockSessionRetrieve(session: ReturnType<typeof makeSession>): void {
  mockRoute('GET', `https://api.stripe.com/v1/checkout/sessions/${session.id}`, () =>
    Response.json(session),
  );
}

// ── Suite: finalizeOrderFromCart guard (DO level) ────────────────────────────

describe('finalizeOrderFromCart guard', () => {
  function finalizeArgs(cartId: string, sessionId: string, email: string) {
    return {
      cartId,
      stripeSessionId: sessionId,
      stripePaymentIntent: `pi_${sessionId}`,
      customerEmail: email,
      shippingName: null,
      shippingPhone: null,
      shippingAddress: null,
      subtotalCents: 2000,
      taxCents: 0,
      shippingCents: 0,
      totalCents: 2000,
      currency: 'USD',
      discountId: null,
      discountCode: null,
      discountAmountCents: 0,
    };
  }

  it('refuses a cart whose reservation was already released (cart_released)', async () => {
    const email = 'guard-released@example.com';
    const cartId = await createCart(email);
    await addItem(cartId, seed.sku, 2);
    const sessionId = uniqueId('cs');
    await checkOutCart(cartId, sessionId);

    const stub = getMerchantStub();

    // Simulate the cron/expired-webhook releasing the checkout
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.releaseAbandonedCheckout(cartId);
    });

    const invBefore = await getInventory(seed.sku);

    const result = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.finalizeOrderFromCart(finalizeArgs(cartId, sessionId, email));
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('cart_released');

    // No order row, no order_items, no inventory movement
    const orderCount = await runInDurableObject(stub, async (instance: MerchantDO) => {
      const rows = instance.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM orders WHERE stripe_checkout_session_id = ?`,
        [sessionId],
      );
      return rows[0]?.count ?? 0;
    });
    expect(orderCount).toBe(0);

    const invAfter = await getInventory(seed.sku);
    expect(invAfter.on_hand).toBe(invBefore.on_hand);
    expect(invAfter.reserved).toBe(invBefore.reserved);
  });

  it('refuses a cart that does not exist (cart_not_found)', async () => {
    const result = await runInDurableObject(getMerchantStub(), async (instance: MerchantDO) => {
      return instance.finalizeOrderFromCart(
        finalizeArgs('no-such-cart', uniqueId('cs'), 'ghost@example.com'),
      );
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('cart_not_found');
  });
});

// ── Suite: late payment for a released cart (route level, full flow) ────────

describe('checkout.session.completed after cart release (orphaned payment)', () => {
  it('creates no order, auto-refunds, records a payment anomaly, and keeps the event claim', async () => {
    const email = 'late-payer@example.com';
    const cartId = await createCart(email);
    await addItem(cartId, seed.sku, 2);
    const sessionId = uniqueId('cs');

    // Register an alert webhook subscribed to order.failed
    const hookRes = await authedFetch('/v1/webhooks', seed.sk, {
      method: 'POST',
      body: JSON.stringify({ url: 'https://alerts.example.com/hook', events: ['order.failed'] }),
    });
    expect(hookRes.ok).toBe(true);
    mockRoute('POST', 'https://alerts.example.com/hook', () => new Response('ok'));

    // Checkout, then force the cart past expiry (beyond the cron grace) and
    // run the cron — inventory released, items deleted, cart expired.
    await checkOutCart(cartId, sessionId, '2020-01-01T00:00:00.000Z');
    const stub = getMerchantStub();
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      await instance.cleanupExpiredCarts();
    });

    const cartStatus = await runInDurableObject(stub, async (instance: MerchantDO) => {
      const [row] = instance.query<{ status: string }>(`SELECT status FROM carts WHERE id = ?`, [
        cartId,
      ]);
      return row?.status;
    });
    expect(cartStatus).toBe('expired');

    const invBefore = await getInventory(seed.sku);

    // The customer pays anyway (stale session) → Stripe delivers completed.
    const session = makeSession(sessionId, cartId, email);
    mockSessionRetrieve(session);

    let refundedPaymentIntent: string | null = null;
    mockRoute('POST', 'https://api.stripe.com/v1/refunds', (_req, body) => {
      refundedPaymentIntent = new URLSearchParams(body).get('payment_intent');
      return Response.json({ id: 're_test_1', object: 'refund', status: 'succeeded' });
    });

    const { response, eventId } = await deliverCompletedWebhook(session);
    expect(response.status).toBe(200);

    // 1. No order (and especially no empty order) was created
    const orderCount = await runInDurableObject(stub, async (instance: MerchantDO) => {
      const rows = instance.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM orders WHERE stripe_checkout_session_id = ?`,
        [sessionId],
      );
      return rows[0]?.count ?? 0;
    });
    expect(orderCount).toBe(0);

    // 2. An automatic refund was attempted for the session's payment intent
    expect(refundedPaymentIntent).toBe(`pi_${sessionId}`);

    // 3. A durable anomaly record exists with the refund outcome
    const anomaly = await runInDurableObject(stub, async (instance: MerchantDO) => {
      const [row] = instance.query<Record<string, unknown>>(
        `SELECT * FROM payment_anomalies WHERE stripe_checkout_session_id = ?`,
        [sessionId],
      );
      return row;
    });
    expect(anomaly).toBeDefined();
    expect(anomaly.type).toBe('orphaned_payment');
    expect(anomaly.cart_id).toBe(cartId);
    expect(anomaly.refund_id).toBe('re_test_1');
    expect(anomaly.refund_status).toBe('refunded');

    // 4. An order.failed alert delivery was recorded
    const alertDeliveries = await runInDurableObject(stub, async (instance: MerchantDO) => {
      const rows = instance.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM webhook_deliveries WHERE event_type = 'order.failed'`,
        [],
      );
      return rows[0]?.count ?? 0;
    });
    expect(alertDeliveries).toBeGreaterThanOrEqual(1);

    // 5. The event claim is kept (Stripe retries must not double-refund)
    const claimKept = await runInDurableObject(stub, async (instance: MerchantDO) => {
      const [row] = instance.query<{ id: string }>(
        `SELECT id FROM events WHERE stripe_event_id = ?`,
        [eventId],
      );
      return !!row;
    });
    expect(claimKept).toBe(true);

    // 6. Inventory untouched by the late payment
    const invAfter = await getInventory(seed.sku);
    expect(invAfter.on_hand).toBe(invBefore.on_hand);
    expect(invAfter.reserved).toBe(invBefore.reserved);
  });
});

// ── Suite: happy path through the refactored webhook handler ────────────────

describe('checkout.session.completed for a live checked_out cart (happy path)', () => {
  it('creates a paid order with the cart items and decrements inventory', async () => {
    const email = 'happy-payer@example.com';
    const cartId = await createCart(email);
    await addItem(cartId, seed.sku, 2);
    const sessionId = uniqueId('cs');
    await checkOutCart(cartId, sessionId); // expiry stays in the future

    const invBefore = await getInventory(seed.sku);

    const session = makeSession(sessionId, cartId, email);
    mockSessionRetrieve(session);

    const { response } = await deliverCompletedWebhook(session);
    expect(response.status).toBe(200);

    const order = await runInDurableObject(getMerchantStub(), async (instance: MerchantDO) => {
      const [row] = instance.query<{ id: string; status: string; total_cents: number }>(
        `SELECT id, status, total_cents FROM orders WHERE stripe_checkout_session_id = ?`,
        [sessionId],
      );
      if (!row) return null;
      const items = instance.query<{ sku: string; qty: number }>(
        `SELECT sku, qty FROM order_items WHERE order_id = ?`,
        [row.id],
      );
      return { ...row, items };
    });

    expect(order).not.toBeNull();
    expect(order?.status).toBe('paid');
    expect(order?.items).toEqual([{ sku: seed.sku, qty: 2 }]);

    const invAfter = await getInventory(seed.sku);
    expect(invAfter.on_hand).toBe(invBefore.on_hand - 2);
    expect(invAfter.reserved).toBe(invBefore.reserved - 2);
  });
});

// ── Suite: Stripe session expiry matches cart expiry ─────────────────────────

describe('POST /carts/{id}/checkout', () => {
  it('creates the Stripe session with expires_at equal to the cart expires_at', async () => {
    // Checkout reads the Stripe key from the config row seeded in beforeAll —
    // the same source the webhook receiver uses (merchant-nx9).
    const email = 'window-buyer@example.com';
    const cartId = await createCart(email);
    await addItem(cartId, seed.sku, 1);

    const sessionId = uniqueId('cs');
    let sessionCreateBody: URLSearchParams | null = null;
    mockRoute('POST', 'https://api.stripe.com/v1/checkout/sessions', (_req, body) => {
      sessionCreateBody = new URLSearchParams(body);
      return Response.json({
        id: sessionId,
        object: 'checkout.session',
        url: `https://checkout.stripe.com/pay/${sessionId}`,
      });
    });

    const beforeMs = Date.now();
    const res = await authedFetch(`/v1/carts/${cartId}/checkout`, seed.pk, {
      method: 'POST',
      body: JSON.stringify({
        success_url: 'https://shop.example.com/success',
        cancel_url: 'https://shop.example.com/cancel',
      }),
    });
    expect(res.status).toBe(200);

    expect(sessionCreateBody).not.toBeNull();
    const stripeExpiresAt = Number(sessionCreateBody!.get('expires_at'));
    expect(Number.isFinite(stripeExpiresAt)).toBe(true);

    // Stripe expiry ≈ now + CHECKOUT_WINDOW_MINUTES
    const expectedMs = beforeMs + CHECKOUT_WINDOW_MINUTES * 60 * 1000;
    expect(Math.abs(stripeExpiresAt * 1000 - expectedMs)).toBeLessThan(10_000);

    // ...and the cart's expires_at is the exact same instant
    const cartExpiresAt = await runInDurableObject(
      getMerchantStub(),
      async (instance: MerchantDO) => {
        const [row] = instance.query<{ expires_at: string }>(
          `SELECT expires_at FROM carts WHERE id = ?`,
          [cartId],
        );
        return row.expires_at;
      },
    );
    expect(new Date(cartExpiresAt).getTime()).toBe(stripeExpiresAt * 1000);
  });
});

// ── Suite: cron grace period ─────────────────────────────────────────────────

describe('cleanupExpiredCarts grace period', () => {
  it('does not release a checked_out cart within the grace window past expiry', async () => {
    const email = 'grace-buyer@example.com';
    const cartId = await createCart(email);
    await addItem(cartId, seed.sku, 1);
    // Expired 2 minutes ago — inside the 10-minute grace window
    const justExpired = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    await checkOutCart(cartId, uniqueId('cs'), justExpired);

    const stub = getMerchantStub();
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      await instance.cleanupExpiredCarts();
    });

    const status = await runInDurableObject(stub, async (instance: MerchantDO) => {
      const [row] = instance.query<{ status: string }>(`SELECT status FROM carts WHERE id = ?`, [
        cartId,
      ]);
      return row?.status;
    });
    // Still checked_out: a payment completed seconds before expiry can finalize
    expect(status).toBe('checked_out');
  });
});
