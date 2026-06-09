/**
 * WebSocket topic authorization tests.
 *
 * Verifies:
 *   (a) Anon socket subscribing to '*' and 'order' receives NO order.created event
 *       when one is broadcast, but DOES receive inventory.updated.
 *   (b) Admin-key socket receives order.created events.
 *   (c) Anon socket dynamic subscribe to 'order' is silently ignored (topic filtered).
 *
 * Broadcasts are triggered via runInDurableObject so we can call DO.broadcast()
 * directly without needing a full order-creation flow.
 */

import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MerchantDO, WSEvent } from '../src/do';
import { type SeedResult, seedStore } from './helpers';

let seed: SeedResult;

beforeAll(async () => {
  seed = await seedStore();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDoStub() {
  const e = env as { MERCHANT: DurableObjectNamespace<MerchantDO> };
  const doId = e.MERCHANT.idFromName('default');
  return e.MERCHANT.get(doId);
}

/**
 * Open a WebSocket connection against SELF and return the WebSocket object.
 * Accepts an optional API key (forwarded as the ?key= param so browsers can use it).
 * Requested topics are passed as ?topics= CSV.
 */
async function openWs(topics: string[], key?: string): Promise<WebSocket> {
  const url = new URL('http://example.com/');
  url.searchParams.set('topics', topics.join(','));
  if (key) url.searchParams.set('key', key);

  const res = await SELF.fetch(url.toString(), {
    headers: { Upgrade: 'websocket' },
  });

  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

/**
 * Collect WS messages for `ms` milliseconds then return them.
 */
function collectMessages(ws: WebSocket, ms = 200): Promise<WSEvent[]> {
  return new Promise((resolve) => {
    const messages: WSEvent[] = [];
    ws.addEventListener('message', (evt) => {
      try {
        messages.push(JSON.parse(evt.data as string) as WSEvent);
      } catch {
        // ignore non-JSON
      }
    });
    setTimeout(() => resolve(messages), ms);
  });
}

/**
 * Broadcast an event via the DO directly (bypasses HTTP auth).
 */
async function broadcastEvent(event: WSEvent): Promise<void> {
  const stub = getDoStub();
  await runInDurableObject(stub, async (instance: MerchantDO) => {
    instance.broadcast(event);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WebSocket topic authorization', () => {
  it('anon socket does NOT receive order.created even when requesting * or order topics, but does receive inventory.updated', async () => {
    // Open anon WS requesting both wildcard and order topic.
    // The worker/DO must silently drop both (admin-only), keeping only the allowed
    // 'inventory' topic that we also request, so inventory.updated still arrives.
    const ws = await openWs(['*', 'order', 'inventory']);

    // Start collecting
    const collecting = collectMessages(ws, 300);

    // Broadcast an order event (admin-only) and an inventory event (public)
    await broadcastEvent({
      type: 'order.created',
      data: { customer_email: 'secret@example.com', order_id: 'ord_test' },
      timestamp: new Date().toISOString(),
    });
    await broadcastEvent({
      type: 'inventory.updated',
      data: { sku: seed.sku, available: 9 },
      timestamp: new Date().toISOString(),
    });

    const msgs = await collecting;
    ws.close();

    const orderMsgs = msgs.filter((m) => m.type === 'order.created');
    const invMsgs = msgs.filter((m) => m.type === 'inventory.updated');

    // '*' and 'order' were silently dropped at upgrade time, so no order events
    expect(orderMsgs).toHaveLength(0);
    // 'inventory' was allowed through, so inventory.updated arrives
    expect(invMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it('admin-key socket receives order.created events', async () => {
    const ws = await openWs(['order', 'inventory'], seed.sk);

    const collecting = collectMessages(ws, 300);

    await broadcastEvent({
      type: 'order.created',
      data: { customer_email: 'admin-test@example.com', order_id: 'ord_admin' },
      timestamp: new Date().toISOString(),
    });
    await broadcastEvent({
      type: 'inventory.updated',
      data: { sku: seed.sku, available: 8 },
      timestamp: new Date().toISOString(),
    });

    const msgs = await collecting;
    ws.close();

    const orderMsgs = msgs.filter((m) => m.type === 'order.created');
    const invMsgs = msgs.filter((m) => m.type === 'inventory.updated');

    expect(orderMsgs).toHaveLength(1);
    expect(invMsgs).toHaveLength(1);
  });

  it('anon socket dynamic subscribe to order topic is silently ignored', async () => {
    const ws = await openWs(['inventory']);

    // Attempt to subscribe to admin-only topic via message
    ws.send(JSON.stringify({ action: 'subscribe', topic: 'order' }));

    const collecting = collectMessages(ws, 300);

    await broadcastEvent({
      type: 'order.created',
      data: { customer_email: 'sneaky@example.com', order_id: 'ord_sneaky' },
      timestamp: new Date().toISOString(),
    });
    await broadcastEvent({
      type: 'inventory.updated',
      data: { sku: seed.sku, available: 7 },
      timestamp: new Date().toISOString(),
    });

    const msgs = await collecting;
    ws.close();

    const orderMsgs = msgs.filter((m) => m.type === 'order.created');
    const invMsgs = msgs.filter((m) => m.type === 'inventory.updated');

    // The subscribe to 'order' should have been silently dropped
    expect(orderMsgs).toHaveLength(0);
    expect(invMsgs.length).toBeGreaterThanOrEqual(1);
  });
});
