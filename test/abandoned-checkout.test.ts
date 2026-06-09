/**
 * Tests for releaseAbandonedCheckout (merchant-dam).
 *
 * Covers:
 *  - checkout abandonment releases inventory reservations + restores usage-limited
 *    discount usage_count + sets cart status to 'expired'
 *  - double-processing (calling releaseAbandonedCheckout twice) is a no-op on the
 *    second call — reservations are not double-released
 *  - cart that was already finalized into an order (status='expired' via
 *    finalizeOrderFromCart) → no-op (wrong_status)
 *  - cart that never existed → no-op (not_found)
 *  - cleanupExpiredCarts phase-2 releases checked_out carts past expires_at
 *  - discount without usage_limit is NOT decremented on abandonment
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

async function createCart(email = 'buyer@example.com'): Promise<string> {
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

async function createDiscount(overrides: Record<string, unknown> = {}): Promise<{
  id: string;
  code: string;
}> {
  const code = `ABAND-${Date.now()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const res = await authedFetch('/v1/discounts', seed.sk, {
    method: 'POST',
    body: JSON.stringify({ code, type: 'percentage', value: 10, ...overrides }),
  });
  if (!res.ok) throw new Error(`createDiscount failed: ${res.status} ${await res.text()}`);
  return jsonBody<{ id: string; code: string }>(res);
}

async function applyDiscount(cartId: string, code: string): Promise<void> {
  const res = await authedFetch(`/v1/carts/${cartId}/apply-discount`, seed.pk, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`applyDiscount failed: ${res.status} ${await res.text()}`);
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

async function getDiscountUsageCount(discountId: string): Promise<number> {
  const stub = getMerchantStub();
  return runInDurableObject(stub, async (instance: MerchantDO) => {
    const [row] = instance.query<{ usage_count: number }>(
      `SELECT usage_count FROM discounts WHERE id = ?`,
      [discountId],
    );
    return row?.usage_count ?? 0;
  });
}

async function getCartStatus(cartId: string): Promise<string | null> {
  const stub = getMerchantStub();
  return runInDurableObject(stub, async (instance: MerchantDO) => {
    const [row] = instance.query<{ status: string }>(`SELECT status FROM carts WHERE id = ?`, [
      cartId,
    ]);
    return row?.status ?? null;
  });
}

// ── Suite: releaseAbandonedCheckout ──────────────────────────────────────────

describe('releaseAbandonedCheckout', () => {
  it('releases inventory and sets cart to expired on abandonment', async () => {
    const cartId = await createCart();
    await addItem(cartId, seed.sku, 2);

    const invBefore = await getInventory(seed.sku);
    expect(invBefore.reserved).toBeGreaterThanOrEqual(2);

    // Drive cart to checked_out via cartBeginCheckout
    const stub = getMerchantStub();
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.cartBeginCheckout(cartId);
    });

    expect(await getCartStatus(cartId)).toBe('checked_out');

    // Release the abandoned checkout
    const result = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.releaseAbandonedCheckout(cartId);
    });

    expect(result.released).toBe(true);
    expect(await getCartStatus(cartId)).toBe('expired');

    const invAfter = await getInventory(seed.sku);
    expect(invAfter.reserved).toBe(invBefore.reserved - 2);
  });

  it('restores usage_count for usage-limited discount on abandonment', async () => {
    const cartId = await createCart('limit-buyer@example.com');
    await addItem(cartId, seed.sku, 1);
    const { id: discountId, code } = await createDiscount({ usage_limit: 5 });
    await applyDiscount(cartId, code);

    const usageBefore = await getDiscountUsageCount(discountId);

    // Transition to checked_out (which increments usage_count)
    const stub = getMerchantStub();
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.cartBeginCheckout(cartId);
    });

    const usageAfterCheckout = await getDiscountUsageCount(discountId);
    expect(usageAfterCheckout).toBe(usageBefore + 1);

    // Release the abandoned checkout
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.releaseAbandonedCheckout(cartId);
    });

    const usageAfterRelease = await getDiscountUsageCount(discountId);
    expect(usageAfterRelease).toBe(usageBefore);
  });

  it('does NOT decrement usage_count for unlimited discounts', async () => {
    const cartId = await createCart('unlimited-buyer@example.com');
    await addItem(cartId, seed.sku, 1);
    // No usage_limit → no reservation was made in cartBeginCheckout
    const { id: discountId, code } = await createDiscount(); // no usage_limit
    await applyDiscount(cartId, code);

    const stub = getMerchantStub();
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.cartBeginCheckout(cartId);
    });

    const usageAfterCheckout = await getDiscountUsageCount(discountId);

    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.releaseAbandonedCheckout(cartId);
    });

    const usageAfterRelease = await getDiscountUsageCount(discountId);
    // Should not have changed (was never incremented, should not be decremented)
    expect(usageAfterRelease).toBe(usageAfterCheckout);
  });

  it('is idempotent — second call is a no-op and does not double-release', async () => {
    const cartId = await createCart('idem-buyer@example.com');
    await addItem(cartId, seed.sku, 2);

    const invBefore = await getInventory(seed.sku);

    const stub = getMerchantStub();
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.cartBeginCheckout(cartId);
    });

    // First release
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.releaseAbandonedCheckout(cartId);
    });

    const invAfterFirst = await getInventory(seed.sku);
    expect(invAfterFirst.reserved).toBe(invBefore.reserved - 2);

    // Second release — must be a no-op
    const secondResult = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.releaseAbandonedCheckout(cartId);
    });

    expect(secondResult.released).toBe(false);
    if (!secondResult.released) expect(secondResult.reason).toBe('wrong_status');

    const invAfterSecond = await getInventory(seed.sku);
    // Reserved must not decrease further
    expect(invAfterSecond.reserved).toBe(invAfterFirst.reserved);
  });

  it('is a no-op for a cart that became an order (status=expired via finalize)', async () => {
    const cartId = await createCart('order-buyer@example.com');
    await addItem(cartId, seed.sku, 1);

    const stub = getMerchantStub();

    // Simulate finalizeOrderFromCart setting cart status to 'expired'
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      // Flip to checked_out first (prerequisite for finalize path)
      instance.run(
        `UPDATE carts SET status = 'checked_out', updated_at = datetime('now') WHERE id = ?`,
        [cartId],
      );
      // Then directly expire it (as finalizeOrderFromCart does)
      instance.run(
        `UPDATE carts SET status = 'expired', updated_at = datetime('now') WHERE id = ?`,
        [cartId],
      );
    });

    expect(await getCartStatus(cartId)).toBe('expired');

    const result = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.releaseAbandonedCheckout(cartId);
    });

    expect(result.released).toBe(false);
    if (!result.released) expect(result.reason).toBe('wrong_status');
  });

  it('returns not_found for a non-existent cart', async () => {
    const stub = getMerchantStub();
    const result = await runInDurableObject(stub, async (instance: MerchantDO) => {
      return instance.releaseAbandonedCheckout('non-existent-cart-id');
    });

    expect(result.released).toBe(false);
    if (!result.released) expect(result.reason).toBe('not_found');
  });
});

// ── Suite: cleanupExpiredCarts phase-2 (cron fallback) ───────────────────────

describe('cleanupExpiredCarts phase-2 (cron fallback for checked_out carts)', () => {
  it('releases checked_out carts past expires_at during cleanup', async () => {
    const cartId = await createCart('cron-buyer@example.com');
    await addItem(cartId, seed.sku, 2);

    const invBefore = await getInventory(seed.sku);

    const stub = getMerchantStub();

    // Transition to checked_out and backdate expires_at to simulate webhook loss
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.cartBeginCheckout(cartId);
      // Backdate expires_at so the cleanup cron treats it as stale
      instance.run(
        `UPDATE carts SET expires_at = '2020-01-01T00:00:00.000Z', updated_at = datetime('now') WHERE id = ?`,
        [cartId],
      );
    });

    expect(await getCartStatus(cartId)).toBe('checked_out');

    // Run cron cleanup
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      await instance.cleanupExpiredCarts();
    });

    expect(await getCartStatus(cartId)).toBe('expired');

    const invAfter = await getInventory(seed.sku);
    expect(invAfter.reserved).toBe(invBefore.reserved - 2);
  });

  it('cron does not release checked_out carts that are not yet expired', async () => {
    const cartId = await createCart('cron-notyet@example.com');
    await addItem(cartId, seed.sku, 1);

    const stub = getMerchantStub();

    // Transition to checked_out with expires_at in the future (default +60min)
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.cartBeginCheckout(cartId);
    });

    expect(await getCartStatus(cartId)).toBe('checked_out');

    await runInDurableObject(stub, async (instance: MerchantDO) => {
      await instance.cleanupExpiredCarts();
    });

    // Cart should still be checked_out (not expired yet)
    expect(await getCartStatus(cartId)).toBe('checked_out');
  });

  it('cron is idempotent with webhook — double-processing does not double-release', async () => {
    const cartId = await createCart('cron-idem@example.com');
    await addItem(cartId, seed.sku, 2);

    const invBefore = await getInventory(seed.sku);

    const stub = getMerchantStub();

    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.cartBeginCheckout(cartId);
      instance.run(`UPDATE carts SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, [
        cartId,
      ]);
    });

    // Simulate webhook processing first
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      instance.releaseAbandonedCheckout(cartId);
    });

    const invAfterWebhook = await getInventory(seed.sku);
    expect(invAfterWebhook.reserved).toBe(invBefore.reserved - 2);

    // Then cron runs — should be a no-op because cart is already 'expired'
    await runInDurableObject(stub, async (instance: MerchantDO) => {
      await instance.cleanupExpiredCarts();
    });

    const invAfterCron = await getInventory(seed.sku);
    // Reserved must not decrease further
    expect(invAfterCron.reserved).toBe(invAfterWebhook.reserved);
  });
});
