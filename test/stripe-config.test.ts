/**
 * Tests for unified Stripe credential resolution (merchant-nx9).
 *
 * The bug: checkout, refunds, and discount sync read env.STRIPE_SECRET_KEY
 * while the webhook receiver and UCP read the config table written by
 * POST /v1/setup/stripe — so a deployment configured exactly as documented
 * could verify webhooks but never check out. All paths now resolve
 * credentials through getStripeConfig(): the config table is the source of
 * truth, env vars are per-field overrides for local dev.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb } from '../src/db';
import type { MerchantDO } from '../src/do';
import { getStripeConfig } from '../src/lib/stripe';
import type { DOStub } from '../src/types';
import { authedFetch, jsonBody, type SeedResult, seedStore } from './helpers';

let seed: SeedResult;

function getMerchantStub() {
  const e = env as { MERCHANT: DurableObjectNamespace<MerchantDO> };
  return e.MERCHANT.get(e.MERCHANT.idFromName('default'));
}

// ── Outbound fetch mocking (same pattern as expired-cart-payment.test.ts) ────

type RouteHandler = (request: Request, bodyText: string) => Response | Promise<Response>;
const fetchRoutes = new Map<string, RouteHandler>();

function mockRoute(method: string, url: string, handler: RouteHandler): void {
  fetchRoutes.set(`${method} ${url}`, handler);
}

beforeAll(async () => {
  seed = await seedStore();

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const handler = fetchRoutes.get(`${request.method} ${url.origin}${url.pathname}`);
    if (!handler) {
      throw new Error(`Unmocked outbound fetch: ${request.method} ${request.url}`);
    }
    const bodyText = new TextDecoder().decode(await request.arrayBuffer().catch(() => undefined));
    return handler(request, bodyText);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  // env mutations and DO storage survive across tests in a file — undo the
  // overrides and remove the stripe config row so each test states its own
  // preconditions.
  delete (env as Record<string, unknown>).STRIPE_SECRET_KEY;
  delete (env as Record<string, unknown>).STRIPE_WEBHOOK_SECRET;
  fetchRoutes.clear();
  await runInDurableObject(getMerchantStub(), async (instance: MerchantDO) => {
    instance.run(`DELETE FROM config WHERE key = 'stripe'`, []);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedStripeConfig(secretKey: string, webhookSecret: string | null): Promise<void> {
  await runInDurableObject(getMerchantStub(), async (instance: MerchantDO) => {
    instance.run(
      `INSERT INTO config (key, value, updated_at) VALUES ('stripe', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify({ secret_key: secretKey, webhook_secret: webhookSecret })],
    );
  });
}

async function createCartWithItem(email: string): Promise<string> {
  const res = await authedFetch('/v1/carts', seed.pk, {
    method: 'POST',
    body: JSON.stringify({ customer_email: email }),
  });
  if (!res.ok) throw new Error(`createCart failed: ${res.status} ${await res.text()}`);
  const { id } = await jsonBody<{ id: string }>(res);

  const addRes = await authedFetch(`/v1/carts/${id}/items/add`, seed.pk, {
    method: 'POST',
    body: JSON.stringify({ sku: seed.sku, qty: 1 }),
  });
  if (!addRes.ok) throw new Error(`addItem failed: ${addRes.status} ${await addRes.text()}`);
  return id;
}

function checkoutBody(): string {
  return JSON.stringify({
    success_url: 'https://shop.example.com/success',
    cancel_url: 'https://shop.example.com/cancel',
  });
}

// ── Suite: documented setup path (config table only, no env vars) ────────────

describe('checkout with config-table-only credentials', () => {
  it('creates a Stripe session using the key from POST /v1/setup/stripe', async () => {
    await seedStripeConfig('sk_test_from_config', 'whsec_unused');

    let authHeader: string | null = null;
    mockRoute('POST', 'https://api.stripe.com/v1/checkout/sessions', (req) => {
      authHeader = req.headers.get('Authorization');
      return Response.json({
        id: 'cs_test_cfg',
        object: 'checkout.session',
        url: 'https://checkout.stripe.com/pay/cs_test_cfg',
      });
    });

    const cartId = await createCartWithItem('config-only@example.com');
    const res = await authedFetch(`/v1/carts/${cartId}/checkout`, seed.pk, {
      method: 'POST',
      body: checkoutBody(),
    });

    expect(res.status).toBe(200);
    const body = await jsonBody<{ checkout_url: string }>(res);
    expect(body.checkout_url).toBe('https://checkout.stripe.com/pay/cs_test_cfg');
    // The session was created with the config-table key — the same source the
    // webhook receiver verifies signatures from.
    expect(authHeader).toBe('Bearer sk_test_from_config');
  });

  it('returns the setup hint only when Stripe is configured nowhere', async () => {
    const cartId = await createCartWithItem('unconfigured@example.com');
    const res = await authedFetch(`/v1/carts/${cartId}/checkout`, seed.pk, {
      method: 'POST',
      body: checkoutBody(),
    });

    expect(res.status).toBe(400);
    const body = await jsonBody<{ error: { message: string } }>(res);
    expect(body.error.message).toContain('/v1/setup/stripe');
  });
});

// ── Suite: resolution precedence ─────────────────────────────────────────────

describe('getStripeConfig precedence', () => {
  const db = () => getDb(getMerchantStub() as unknown as DOStub);

  it('env vars override the config table per field', async () => {
    await seedStripeConfig('sk_from_config', 'whsec_from_config');

    const merged = await getStripeConfig(db(), { STRIPE_SECRET_KEY: 'sk_from_env' });
    expect(merged.secretKey).toBe('sk_from_env');
    expect(merged.webhookSecret).toBe('whsec_from_config');
  });

  it('returns nulls when nothing is configured', async () => {
    const cfg = await getStripeConfig(db());
    expect(cfg).toEqual({ secretKey: null, webhookSecret: null });
  });

  it('treats a malformed config row as not configured', async () => {
    await runInDurableObject(getMerchantStub(), async (instance: MerchantDO) => {
      instance.run(
        `INSERT INTO config (key, value, updated_at) VALUES ('stripe', 'not-json', datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [],
      );
    });

    const cfg = await getStripeConfig(db());
    expect(cfg).toEqual({ secretKey: null, webhookSecret: null });
  });
});
