import { getDb } from '../db';
import { type DOStub, now, uuid } from '../types';

export type WebhookEventType =
  | 'order.created'
  | 'order.updated'
  | 'order.shipped'
  | 'order.refunded'
  | 'inventory.low';

export type WebhookPayload = {
  id: string;
  type: WebhookEventType;
  created_at: string;
  data: Record<string, unknown>;
};

/** Attempts made in a single deliverWebhook call (immediate + within-call retries). */
const ATTEMPTS_PER_RUN = 3;

/**
 * Maximum cumulative attempts across all delivery runs (initial dispatch +
 * cron-driven retries). 3 immediate + up to 2 cron retry runs × 3 = 9 total.
 */
export const MAX_TOTAL_ATTEMPTS = 9;

const LOW_INVENTORY_THRESHOLD = 5;

/**
 * Exponential-backoff delay between within-run attempts, in milliseconds.
 * Exported so tests can replace it with a zero-delay stub without affecting
 * production behaviour.
 *
 * Usage in tests:
 *   import { setBackoffMs } from '../src/lib/webhooks';
 *   beforeAll(() => setBackoffMs(() => 0));
 *   afterAll(() => setBackoffMs(null));  // restore default
 */
let _backoffMs: ((attempt: number) => number) | null = null;

export function setBackoffMs(fn: ((attempt: number) => number) | null): void {
  _backoffMs = fn;
}

function backoffMs(attempt: number): number {
  return _backoffMs ? _backoffMs(attempt) : 2 ** attempt * 1000;
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return (
    'whsec_' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

export async function dispatchWebhooks(
  stub: DOStub,
  ctx: ExecutionContext,
  eventType: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  const db = getDb(stub);

  const webhooks = await db.query<{
    id: string;
    url: string;
    events: string;
    secret: string;
  }>(`SELECT id, url, events, secret FROM webhooks WHERE status = 'active'`);

  for (const webhook of webhooks) {
    const subscribedEvents: string[] = JSON.parse(webhook.events);

    const isSubscribed = subscribedEvents.some((e) => {
      if (e === '*') return true;
      if (e === eventType) return true;
      if (e.endsWith('.*')) {
        const prefix = e.slice(0, -2);
        return eventType.startsWith(`${prefix}.`);
      }
      return false;
    });

    if (!isSubscribed) continue;

    const deliveryId = uuid();
    const payload: WebhookPayload = {
      id: deliveryId,
      type: eventType,
      created_at: now(),
      data,
    };

    await db.run(
      `INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [deliveryId, webhook.id, eventType, JSON.stringify(payload), now()],
    );

    ctx.waitUntil(
      deliverWebhook(stub, webhook.id, webhook.url, webhook.secret, deliveryId, payload, 0),
    );
  }
}

/**
 * Attempt delivery of a webhook up to ATTEMPTS_PER_RUN times, starting from
 * `startAttempt` (the row's current cumulative attempt count). Each attempt
 * increments the row's `attempts` column so the total is always cumulative
 * across cron retry runs.
 */
async function deliverWebhook(
  stub: DOStub,
  webhookId: string,
  url: string,
  secret: string,
  deliveryId: string,
  payload: WebhookPayload,
  startAttempt: number,
): Promise<void> {
  const db = getDb(stub);
  const payloadString = JSON.stringify(payload);
  const signature = await signPayload(payloadString, secret);
  const timestamp = Math.floor(Date.now() / 1000);

  let lastError: Error | null = null;
  let responseCode: number | null = null;
  let responseBody: string | null = null;

  for (let n = 1; n <= ATTEMPTS_PER_RUN; n++) {
    const cumulativeAttempts = startAttempt + n;
    try {
      await db.run(`UPDATE webhook_deliveries SET attempts = ?, last_attempt_at = ? WHERE id = ?`, [
        cumulativeAttempts,
        now(),
        deliveryId,
      ]);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Merchant-Signature': signature,
          'X-Merchant-Timestamp': String(timestamp),
          'X-Merchant-Delivery-Id': deliveryId,
          'User-Agent': 'Merchant-Webhook/1.0',
        },
        body: payloadString,
      });

      responseCode = response.status;
      responseBody = await response.text().catch(() => null);

      if (response.ok) {
        await db.run(
          `UPDATE webhook_deliveries
           SET status = 'success', response_code = ?, response_body = ?
           WHERE id = ?`,
          [responseCode, responseBody?.slice(0, 1000), deliveryId],
        );
        return;
      }

      if (responseCode >= 400 && responseCode < 500 && responseCode !== 429) {
        await db.run(
          `UPDATE webhook_deliveries
           SET status = 'failed', response_code = ?, response_body = ?
           WHERE id = ?`,
          [responseCode, responseBody?.slice(0, 1000), deliveryId],
        );
        return;
      }

      lastError = new Error(`HTTP ${responseCode}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (n < ATTEMPTS_PER_RUN) {
      await new Promise((r) => setTimeout(r, backoffMs(n)));
    }
  }

  await db.run(
    `UPDATE webhook_deliveries
     SET status = 'failed', response_code = ?, response_body = ?
     WHERE id = ?`,
    [responseCode, lastError?.message?.slice(0, 1000) || responseBody?.slice(0, 1000), deliveryId],
  );
}

export async function retryDelivery(
  stub: DOStub,
  webhook: { id: string; url: string; secret: string },
  delivery: { id: string; payload: string; attempts: number },
): Promise<void> {
  const payload = JSON.parse(delivery.payload);
  await deliverWebhook(
    stub,
    webhook.id,
    webhook.url,
    webhook.secret,
    delivery.id,
    payload,
    delivery.attempts,
  );
}

export async function checkLowInventory(
  stub: DOStub,
  ctx: ExecutionContext,
  sku: string,
  available: number,
): Promise<void> {
  if (available <= LOW_INVENTORY_THRESHOLD && available >= 0) {
    await dispatchWebhooks(stub, ctx, 'inventory.low', {
      sku,
      available,
      threshold: LOW_INVENTORY_THRESHOLD,
    });
  }
}

export async function retryFailedDeliveries(stub: DOStub, ctx: ExecutionContext): Promise<number> {
  const db = getDb(stub);

  const failed = await db.query<{
    id: string;
    webhook_id: string;
    payload: string;
    attempts: number;
  }>(
    `SELECT wd.id, wd.webhook_id, wd.payload, wd.attempts
     FROM webhook_deliveries wd
     JOIN webhooks w ON w.id = wd.webhook_id
     WHERE wd.status = 'failed'
       AND wd.attempts < ?
       AND w.status = 'active'
       AND wd.created_at > datetime('now', '-24 hours')
     LIMIT 50`,
    [MAX_TOTAL_ATTEMPTS],
  );

  for (const delivery of failed) {
    const [webhook] = await db.query<{ url: string; secret: string }>(
      `SELECT url, secret FROM webhooks WHERE id = ?`,
      [delivery.webhook_id],
    );

    if (webhook) {
      await db.run(`UPDATE webhook_deliveries SET status = 'pending' WHERE id = ?`, [delivery.id]);

      ctx.waitUntil(
        deliverWebhook(
          stub,
          delivery.webhook_id,
          webhook.url,
          webhook.secret,
          delivery.id,
          JSON.parse(delivery.payload),
          delivery.attempts,
        ),
      );
    }
  }

  return failed.length;
}
