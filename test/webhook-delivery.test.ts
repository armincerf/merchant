/**
 * Tests for outbound webhook delivery retry logic (merchant-jgo).
 *
 * Covers:
 *  (a) dispatch → target returns 500 every time → delivery ends status=failed, attempts=3
 *  (b) retryFailedDeliveries → attempts grow cumulatively; at 9 the delivery is
 *      no longer selected by the query
 *  (c) target returns 200 on a retry → status=success
 *
 * We call dispatchWebhooks / retryFailedDeliveries directly with a mock
 * ExecutionContext (collect waitUntil promises, then await them) and mock the
 * global fetch to control endpoint responses.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MerchantDO } from '../src/do';
import {
  dispatchWebhooks,
  MAX_TOTAL_ATTEMPTS,
  retryFailedDeliveries,
  setBackoffMs,
} from '../src/lib/webhooks';
import type { DOStub } from '../src/types';
import { authedFetch, jsonBody, type SeedResult, seedStore } from './helpers';

// ── Disable exponential backoff in tests ────────────────────────────────────

beforeAll(() => {
  setBackoffMs(() => 0);
});

afterEach(() => {
  // Restore real fetch after each test to avoid leaking mocks
  globalThis.fetch = realFetch;
});

const realFetch = globalThis.fetch;

// ── Helpers ─────────────────────────────────────────────────────────────────

function getMerchantStub() {
  const e = env as { MERCHANT: DurableObjectNamespace<MerchantDO> };
  const doId = e.MERCHANT.idFromName('default');
  return e.MERCHANT.get(doId);
}

/**
 * A mock ExecutionContext that collects waitUntil promises and exposes a helper
 * to drain them all (simulating end of event-loop turn).
 */
function mockCtx() {
  const promises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      promises.push(p);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  async function drain() {
    await Promise.all(promises.splice(0));
  }
  return { ctx, drain };
}

/** Create a webhook via the API and return its id + secret. */
async function createWebhookViaApi(
  sk: string,
  url: string,
): Promise<{ id: string; secret: string }> {
  const res = await authedFetch('/v1/webhooks', sk, {
    method: 'POST',
    body: JSON.stringify({ url, events: ['order.created'] }),
  });
  if (!res.ok) throw new Error(`createWebhook failed: ${res.status} ${await res.text()}`);
  return jsonBody<{ id: string; secret: string }>(res);
}

/** Read a delivery row directly from the DO. */
async function getDeliveryRow(
  stub: DurableObjectStub<MerchantDO>,
  deliveryId: string,
): Promise<{ status: string; attempts: number }> {
  return runInDurableObject(stub, (instance: MerchantDO) => {
    const rows = instance.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM webhook_deliveries WHERE id = ?`,
      [deliveryId],
    );
    return rows[0];
  });
}

/**
 * Get the most recent delivery row for a given webhook id (by created_at DESC).
 */
async function getLatestDeliveryForWebhook(
  stub: DurableObjectStub<MerchantDO>,
  webhookId: string,
): Promise<{ id: string; status: string; attempts: number }> {
  return runInDurableObject(stub, (instance: MerchantDO) => {
    const rows = instance.query<{ id: string; status: string; attempts: number }>(
      `SELECT id, status, attempts FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 1`,
      [webhookId],
    );
    return rows[0];
  });
}

// ── Suite setup ─────────────────────────────────────────────────────────────

let seed: SeedResult;

beforeAll(async () => {
  seed = await seedStore();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('webhook delivery retry semantics', () => {
  it('(a) all 3 immediate attempts fail → delivery status=failed, attempts=3', async () => {
    const stub = getMerchantStub();
    const targetUrl = 'https://webhook-target.example.com/hook-a';

    // Register webhook
    const webhook = await createWebhookViaApi(seed.sk, targetUrl);

    // Mock fetch: always 500
    let callCount = 0;
    globalThis.fetch = async (_input: RequestInfo | URL) => {
      callCount++;
      return new Response('server error', { status: 500 });
    };

    const { ctx, drain } = mockCtx();
    await dispatchWebhooks(stub as unknown as DOStub, ctx, 'order.created', { test: true });
    await drain();

    // Should have made 3 HTTP calls (ATTEMPTS_PER_RUN)
    expect(callCount).toBe(3);

    const delivery = await getLatestDeliveryForWebhook(stub, webhook.id);
    expect(delivery.status).toBe('failed');
    expect(delivery.attempts).toBe(3);
  });

  it('(b) retryFailedDeliveries increments attempts cumulatively; stops selecting at MAX_TOTAL_ATTEMPTS', async () => {
    const stub = getMerchantStub();
    const targetUrl = 'https://webhook-target.example.com/hook-b';

    const webhook = await createWebhookViaApi(seed.sk, targetUrl);

    // First dispatch: 3 failing attempts → attempts=3
    globalThis.fetch = async () => new Response('fail', { status: 500 });

    const { ctx: ctx1, drain: drain1 } = mockCtx();
    await dispatchWebhooks(stub as unknown as DOStub, ctx1, 'order.created', { step: 1 });
    await drain1();

    const initialDelivery = await getLatestDeliveryForWebhook(stub, webhook.id);
    expect(initialDelivery.attempts).toBe(3);
    expect(initialDelivery.status).toBe('failed');

    const deliveryId = initialDelivery.id;

    // First cron retry: attempts goes 3→6
    const { ctx: ctx2, drain: drain2 } = mockCtx();
    await retryFailedDeliveries(stub as unknown as DOStub, ctx2);
    await drain2();

    let row = await getDeliveryRow(stub, deliveryId);
    expect(row.attempts).toBe(6);
    expect(row.status).toBe('failed');

    // Second cron retry: attempts goes 6→9
    const { ctx: ctx3, drain: drain3 } = mockCtx();
    await retryFailedDeliveries(stub as unknown as DOStub, ctx3);
    await drain3();

    row = await getDeliveryRow(stub, deliveryId);
    expect(row.attempts).toBe(MAX_TOTAL_ATTEMPTS); // 9
    expect(row.status).toBe('failed');

    // Third cron retry: delivery is NOT selected (attempts >= MAX_TOTAL_ATTEMPTS)
    let retried = 0;
    const { ctx: ctx4, drain: drain4 } = mockCtx();
    // Intercept to count – we still fail so any unexpected delivery would show up
    globalThis.fetch = async () => {
      retried++;
      return new Response('fail', { status: 500 });
    };
    const count = await retryFailedDeliveries(stub as unknown as DOStub, ctx4);
    await drain4();

    expect(count).toBe(0); // delivery was NOT picked up
    expect(retried).toBe(0);

    row = await getDeliveryRow(stub, deliveryId);
    expect(row.attempts).toBe(MAX_TOTAL_ATTEMPTS); // still 9, unchanged
  });

  it('(c) target returns 200 on cron retry → status=success', async () => {
    const stub = getMerchantStub();
    const targetUrl = 'https://webhook-target.example.com/hook-c';

    const webhook = await createWebhookViaApi(seed.sk, targetUrl);

    // Dispatch: all fail → status=failed, attempts=3
    globalThis.fetch = async () => new Response('fail', { status: 500 });

    const { ctx: ctx1, drain: drain1 } = mockCtx();
    await dispatchWebhooks(stub as unknown as DOStub, ctx1, 'order.created', { step: 1 });
    await drain1();

    const initialDelivery = await getLatestDeliveryForWebhook(stub, webhook.id);
    expect(initialDelivery.status).toBe('failed');
    const deliveryId = initialDelivery.id;

    // Cron retry: first attempt in retry run succeeds
    globalThis.fetch = async () => new Response('ok', { status: 200 });

    const { ctx: ctx2, drain: drain2 } = mockCtx();
    await retryFailedDeliveries(stub as unknown as DOStub, ctx2);
    await drain2();

    const row = await getDeliveryRow(stub, deliveryId);
    expect(row.status).toBe('success');
    // attempts should be 3 (from dispatch) + 1 (first attempt in retry run succeeds)
    expect(row.attempts).toBe(4);
  });
});
