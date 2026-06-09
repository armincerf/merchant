/**
 * Tests for Stripe webhook idempotency (merchant-46n).
 *
 * Covers:
 *  (a) claimEvent twice with the same stripe_event_id → first {claimed:true}, second {claimed:false}
 *  (b) releaseEventClaim then claimEvent again → {claimed:true} (Stripe retry can reprocess)
 *  (c) finalizeOrderFromCart twice with the same stripeSessionId → second returns already_finalized,
 *      inventory is decremented exactly once
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

beforeAll(async () => {
  seed = await seedStore();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createCart(email = 'webhook-buyer@example.com'): Promise<string> {
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

function uniqueEventId(): string {
  return `evt_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueSessionId(): string {
  return `cs_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Suite: claimEvent / releaseEventClaim ─────────────────────────────────────

describe('claimEvent', () => {
  it('(a) returns claimed=true on first call, claimed=false on second call for same event id', async () => {
    const stub = getMerchantStub();
    const stripeEventId = uniqueEventId();

    const first = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.claimEvent(stripeEventId, 'checkout.session.completed', '{}');
    });
    expect(first.claimed).toBe(true);

    const second = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.claimEvent(stripeEventId, 'checkout.session.completed', '{}');
    });
    expect(second.claimed).toBe(false);
  });

  it('(b) after releaseEventClaim, claimEvent returns claimed=true again', async () => {
    const stub = getMerchantStub();
    const stripeEventId = uniqueEventId();

    // Claim it
    const claimed = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.claimEvent(stripeEventId, 'checkout.session.completed', '{}');
    });
    expect(claimed.claimed).toBe(true);

    // Release (simulates processing failure)
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.releaseEventClaim(stripeEventId);
    });

    // Claim again — Stripe's retry should succeed
    const reclaimed = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.claimEvent(stripeEventId, 'checkout.session.completed', '{}');
    });
    expect(reclaimed.claimed).toBe(true);
  });
});

// ── Suite: finalizeOrderFromCart idempotency ──────────────────────────────────

describe('finalizeOrderFromCart idempotency', () => {
  it('(c) second call with same stripeSessionId returns already_finalized; inventory decremented once', async () => {
    const stub = getMerchantStub();

    // Set up a cart with one item
    const cartId = await createCart('finalize-idem@example.com');
    await addItem(cartId, seed.sku, 2);

    const invBefore = await getInventory(seed.sku);

    // Flip cart to checked_out so finalizeOrderFromCart can process it
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.cartBeginCheckout(cartId);
    });

    const stripeSessionId = uniqueSessionId();

    const finalizeArgs = {
      cartId,
      stripeSessionId,
      stripePaymentIntent: null,
      customerEmail: 'finalize-idem@example.com',
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

    // First finalize — should succeed
    const firstResult = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.finalizeOrderFromCart(finalizeArgs);
    });
    expect(firstResult.ok).toBe(true);

    const invAfterFirst = await getInventory(seed.sku);
    // on_hand should have decreased by 2 (sale)
    expect(invAfterFirst.on_hand).toBe(invBefore.on_hand - 2);

    // Second finalize with same stripeSessionId — should return already_finalized
    const secondResult = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.finalizeOrderFromCart(finalizeArgs);
    });
    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok && secondResult.code === 'already_finalized') {
      // orderId should point to the original order
      if (firstResult.ok) {
        expect(secondResult.orderId).toBe(firstResult.orderId);
      }
    } else {
      // Force a readable failure if we got an unexpected error code
      expect(secondResult.ok).toBe(false);
      expect(!secondResult.ok && secondResult.code).toBe('already_finalized');
    }

    // Inventory must not have been decremented a second time
    const invAfterSecond = await getInventory(seed.sku);
    expect(invAfterSecond.on_hand).toBe(invAfterFirst.on_hand);

    // Verify there is exactly one order row for this session
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
