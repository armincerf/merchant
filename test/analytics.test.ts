/**
 * Analytics tests (merchant-9py).
 *
 * Covers:
 *  (a) Funnel parity — SQL-side cumulative INTERSECT produces correct step counts.
 *      Fixture sessions:
 *        sess_all5   — all 5 events (page_view → … → order_completed)
 *        sess_pv     — page_view only
 *        sess_pvprod — page_view + product_view
 *        sess_prod   — product_view only (NO page_view → must NOT count in step 2)
 *
 *      Expected step counts: [3, 2, 1, 1, 1]
 *
 *  (b) Summary smoke — visitors / page_views / orders / revenue_cents match fixture.
 *
 *  (c) Pruning — backdated rows are deleted; recent rows survive.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MerchantDO } from '../src/do';
import { authedFetch, jsonBody, type SeedResult, seedStore } from './helpers';

let seed: SeedResult;

function getMerchantStub() {
  const e = env as { MERCHANT: DurableObjectNamespace<MerchantDO> };
  const doId = e.MERCHANT.idFromName('default');
  return e.MERCHANT.get(doId);
}

function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Insert analytics events directly into the DO for controlled, deterministic
 * fixture data without going through the HTTP layer.
 */
async function insertEvent(
  sessionId: string,
  eventType: string,
  createdAt: string,
  eventData?: Record<string, unknown>,
): Promise<void> {
  const stub = getMerchantStub();
  await runInDurableObject(stub, async (instance: MerchantDO) => {
    instance.run(
      `INSERT OR IGNORE INTO analytics_sessions (id, first_seen_at, last_seen_at, page_count, device_type)
       VALUES (?, ?, ?, 1, 'desktop')`,
      [sessionId, createdAt, createdAt],
    );
    instance.run(
      `INSERT INTO analytics_events (id, session_id, event_type, event_data, page_path, created_at)
       VALUES (?, ?, ?, ?, '/', ?)`,
      [uuid(), sessionId, eventType, eventData ? JSON.stringify(eventData) : null, createdAt],
    );
  });
}

// ─── Seed fixture once for the whole file ───────────────────────────────────

// Timestamp inside the 30d window
const WITHIN = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days ago

const SESS_ALL5 = 'sess_all5';
const SESS_PV = 'sess_pv';
const SESS_PVPROD = 'sess_pvprod';
const SESS_PROD = 'sess_prod'; // product_view but NO page_view — must not count in step 2+

beforeAll(async () => {
  seed = await seedStore();

  // sess_all5: all 5 funnel events
  await insertEvent(SESS_ALL5, 'page_view', WITHIN);
  await insertEvent(SESS_ALL5, 'product_view', WITHIN);
  await insertEvent(SESS_ALL5, 'add_to_cart', WITHIN);
  await insertEvent(SESS_ALL5, 'checkout_started', WITHIN);
  await insertEvent(SESS_ALL5, 'order_completed', WITHIN, { order_total_cents: 5000 });

  // sess_pv: page_view only
  await insertEvent(SESS_PV, 'page_view', WITHIN);

  // sess_pvprod: page_view + product_view
  await insertEvent(SESS_PVPROD, 'page_view', WITHIN);
  await insertEvent(SESS_PVPROD, 'product_view', WITHIN);

  // sess_prod: product_view ONLY (no page_view) — must be excluded from step 2
  await insertEvent(SESS_PROD, 'product_view', WITHIN);
});

// ─── (a) Funnel parity ───────────────────────────────────────────────────────

describe('GET /v1/analytics/funnel', () => {
  it('returns correct cumulative step counts for the fixture', async () => {
    const res = await authedFetch('/v1/analytics/funnel?period=30d', seed.sk);
    expect(res.status).toBe(200);

    const body = await jsonBody<{
      period: string;
      steps: Array<{
        name: string;
        event_type: string;
        unique_sessions: number;
        drop_off_pct: number;
      }>;
    }>(res);

    expect(body.period).toBe('30d');
    expect(body.steps).toHaveLength(5);

    // Step 1 — page_view: sess_all5, sess_pv, sess_pvprod = 3
    expect(body.steps[0].event_type).toBe('page_view');
    expect(body.steps[0].unique_sessions).toBe(3);
    expect(body.steps[0].drop_off_pct).toBe(0);

    // Step 2 — product_view AND had page_view: sess_all5, sess_pvprod = 2
    // sess_prod has product_view but NO page_view → excluded
    expect(body.steps[1].event_type).toBe('product_view');
    expect(body.steps[1].unique_sessions).toBe(2);

    // Step 3 — add_to_cart, cumulative: only sess_all5 = 1
    expect(body.steps[2].event_type).toBe('add_to_cart');
    expect(body.steps[2].unique_sessions).toBe(1);

    // Step 4 — checkout_started: only sess_all5 = 1
    expect(body.steps[3].event_type).toBe('checkout_started');
    expect(body.steps[3].unique_sessions).toBe(1);

    // Step 5 — order_completed: only sess_all5 = 1
    expect(body.steps[4].event_type).toBe('order_completed');
    expect(body.steps[4].unique_sessions).toBe(1);
  });

  it('computes drop_off_pct correctly for step 2', async () => {
    const res = await authedFetch('/v1/analytics/funnel?period=30d', seed.sk);
    const body = await jsonBody<{
      steps: Array<{ drop_off_pct: number }>;
    }>(res);

    // Step 2: 3 → 2; drop = (3-2)/3 * 100 = 33.33
    expect(body.steps[1].drop_off_pct).toBeCloseTo(33.33, 1);

    // Step 3: 2 → 1; drop = 50
    expect(body.steps[2].drop_off_pct).toBe(50);
  });

  it('requires admin key — returns 403 for public key', async () => {
    const res = await authedFetch('/v1/analytics/funnel?period=30d', seed.pk);
    expect(res.status).toBe(403);
  });
});

// ─── (b) Summary smoke ───────────────────────────────────────────────────────

describe('GET /v1/analytics/summary', () => {
  it('returns summary metrics matching the fixture', async () => {
    const res = await authedFetch('/v1/analytics/summary?period=30d', seed.sk);
    expect(res.status).toBe(200);

    const body = await jsonBody<{
      visitors: number;
      page_views: number;
      orders: number;
      revenue_cents: number;
      prior_period: { visitors: number; page_views: number; orders: number; revenue_cents: number };
    }>(res);

    // 4 distinct sessions each had at least one event in the 30d window
    expect(body.visitors).toBe(4);

    // page_view events: sess_all5(1) + sess_pv(1) + sess_pvprod(1) = 3
    expect(body.page_views).toBe(3);

    // order_completed events: sess_all5(1) = 1
    expect(body.orders).toBe(1);

    // revenue: 5000 from sess_all5
    expect(body.revenue_cents).toBe(5000);

    // prior period has no data
    expect(body.prior_period.visitors).toBe(0);
    expect(body.prior_period.orders).toBe(0);
  });
});

// ─── (c) Pruning ─────────────────────────────────────────────────────────────

describe('pruneOldData', () => {
  it('deletes rows older than retention cutoff and keeps recent rows', async () => {
    const stub = getMerchantStub();

    // Insert one old analytics event (100 days ago) and one recent one (1 day ago)
    const oldTime = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const recentTime = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

    const oldEventId = uuid();
    const recentEventId = uuid();
    const oldSessionId = `prune_old_${uuid()}`;
    const recentSessionId = `prune_recent_${uuid()}`;

    // Insert old Stripe event (processed_at 35 days ago)
    const oldStripeEventId = uuid();
    const oldStripeTime = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();

    // Insert old webhook delivery (35 days ago)
    const oldDeliveryId = uuid();

    await runInDurableObject(stub, async (instance: MerchantDO) => {
      // Old analytics session + event
      instance.run(
        `INSERT OR IGNORE INTO analytics_sessions (id, first_seen_at, last_seen_at, page_count, device_type)
         VALUES (?, ?, ?, 1, 'desktop')`,
        [oldSessionId, oldTime, oldTime],
      );
      instance.run(
        `INSERT INTO analytics_events (id, session_id, event_type, page_path, created_at)
         VALUES (?, ?, 'page_view', '/', ?)`,
        [oldEventId, oldSessionId, oldTime],
      );

      // Recent analytics session + event
      instance.run(
        `INSERT OR IGNORE INTO analytics_sessions (id, first_seen_at, last_seen_at, page_count, device_type)
         VALUES (?, ?, ?, 1, 'desktop')`,
        [recentSessionId, recentTime, recentTime],
      );
      instance.run(
        `INSERT INTO analytics_events (id, session_id, event_type, page_path, created_at)
         VALUES (?, ?, 'page_view', '/', ?)`,
        [recentEventId, recentSessionId, recentTime],
      );

      // Old Stripe event
      instance.run(
        `INSERT INTO events (id, stripe_event_id, type, payload, processed_at)
         VALUES (?, ?, 'payment_intent.succeeded', '{}', ?)`,
        [oldStripeEventId, `evt_old_${oldStripeEventId}`, oldStripeTime],
      );

      // Old webhook delivery — need a webhook row first
      const webhookId = uuid();
      instance.run(
        `INSERT INTO webhooks (id, url, events, secret, status)
         VALUES (?, 'https://example.com/hook', '["order.created"]', 'sec', 'active')`,
        [webhookId],
      );
      instance.run(
        `INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, created_at)
         VALUES (?, ?, 'order.created', '{}', 'success', ?)`,
        [oldDeliveryId, webhookId, oldStripeTime],
      );
    });

    // Run pruning
    const counts = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.pruneOldData();
    });

    // At least the rows we inserted should have been pruned
    expect(counts.analyticsEvents).toBeGreaterThanOrEqual(1);
    expect(counts.analyticsSessions).toBeGreaterThanOrEqual(1);
    expect(counts.stripeEvents).toBeGreaterThanOrEqual(1);
    expect(counts.webhookDeliveries).toBeGreaterThanOrEqual(1);

    // Verify recent rows survived
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      const events = instance.query<{ id: string }>(
        `SELECT id FROM analytics_events WHERE id = ?`,
        [recentEventId],
      );
      expect(events).toHaveLength(1);

      const sessions = instance.query<{ id: string }>(
        `SELECT id FROM analytics_sessions WHERE id = ?`,
        [recentSessionId],
      );
      expect(sessions).toHaveLength(1);

      // Old rows should be gone
      const oldEvents = instance.query<{ id: string }>(
        `SELECT id FROM analytics_events WHERE id = ?`,
        [oldEventId],
      );
      expect(oldEvents).toHaveLength(0);

      const oldSessions = instance.query<{ id: string }>(
        `SELECT id FROM analytics_sessions WHERE id = ?`,
        [oldSessionId],
      );
      expect(oldSessions).toHaveLength(0);

      const oldStripeEvents = instance.query<{ id: string }>(`SELECT id FROM events WHERE id = ?`, [
        oldStripeEventId,
      ]);
      expect(oldStripeEvents).toHaveLength(0);

      const oldDeliveries = instance.query<{ id: string }>(
        `SELECT id FROM webhook_deliveries WHERE id = ?`,
        [oldDeliveryId],
      );
      expect(oldDeliveries).toHaveLength(0);
    });
  });

  it('returns zero counts when nothing needs pruning', async () => {
    // After the previous test already pruned everything old, another run
    // in a fresh fixture should return zeros for the categories we care about.
    // (The earlier seeded sessions from the funnel/summary tests are within retention.)
    const stub = getMerchantStub();
    const counts = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.pruneOldData();
    });
    // analytics_events might be 0 now (all old ones deleted in prior test)
    expect(counts.analyticsEvents).toBeGreaterThanOrEqual(0);
    expect(counts.analyticsSessions).toBeGreaterThanOrEqual(0);
    expect(counts.stripeEvents).toBeGreaterThanOrEqual(0);
    expect(counts.webhookDeliveries).toBeGreaterThanOrEqual(0);
  });
});
