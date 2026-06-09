/**
 * Concurrency tests for atomic DO transaction methods.
 *
 * These tests verify that multi-step mutations implemented as single
 * transactionSync DO calls cannot race against each other:
 *
 *  1. Two concurrent cart-add requests against 1 unit of stock → exactly one
 *     200 and one 409 (no double-booking).
 *  2. A failed cartReplaceItems never leaves reserved < 0.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { authedFetch, jsonBody, type SeedResult, seedStore } from './helpers';

let seed: SeedResult;

beforeAll(async () => {
  seed = await seedStore();
});

describe('concurrent cart add - inventory atomicity', () => {
  it('with 1 unit of stock, two concurrent adds → exactly one 200 and one 409', async () => {
    // Set inventory to exactly 1 unit by creating a new dedicated cart + SKU
    // The seeded inventory starts at 10; we use a fresh cart so other tests
    // don't interfere, but we need to deplete inventory down to 1.
    // Simplest: create two carts and fire concurrent adds, each asking for 1 unit.
    // Since inventory is 10 at seed time and tests within the same file share
    // storage, we deplete to 1 first.

    // Step 1: Deplete inventory to exactly 1 remaining unit via a cart that
    // takes 9 units (leave 1 available).
    const drainCartRes = await authedFetch('/v1/carts', seed.pk, {
      method: 'POST',
      body: JSON.stringify({ customer_email: 'drain@example.com' }),
    });
    const { id: drainCartId } = await jsonBody<{ id: string }>(drainCartRes);

    await authedFetch(`/v1/carts/${drainCartId}/items/add`, seed.pk, {
      method: 'POST',
      body: JSON.stringify({ sku: seed.sku, qty: 9 }),
    });

    // Verify 1 unit available
    const invBefore = await authedFetch(`/v1/inventory?sku=${seed.sku}`, seed.sk);
    const invBeforeBody = await jsonBody<{
      items: Array<{ sku: string; on_hand: number; reserved: number; available: number }>;
    }>(invBefore);
    const available = invBeforeBody.items.find((i) => i.sku === seed.sku)?.available ?? 0;
    expect(available).toBe(1);

    // Step 2: Create two carts and fire concurrent add requests for the last unit
    const [cartARes, cartBRes] = await Promise.all([
      authedFetch('/v1/carts', seed.pk, {
        method: 'POST',
        body: JSON.stringify({ customer_email: 'buyer-a@example.com' }),
      }),
      authedFetch('/v1/carts', seed.pk, {
        method: 'POST',
        body: JSON.stringify({ customer_email: 'buyer-b@example.com' }),
      }),
    ]);
    const { id: cartAId } = await jsonBody<{ id: string }>(cartARes);
    const { id: cartBId } = await jsonBody<{ id: string }>(cartBRes);

    // Fire both adds concurrently — only one should succeed
    const [resA, resB] = await Promise.all([
      authedFetch(`/v1/carts/${cartAId}/items/add`, seed.pk, {
        method: 'POST',
        body: JSON.stringify({ sku: seed.sku, qty: 1 }),
      }),
      authedFetch(`/v1/carts/${cartBId}/items/add`, seed.pk, {
        method: 'POST',
        body: JSON.stringify({ sku: seed.sku, qty: 1 }),
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();

    expect(statuses).toEqual([200, 409]);

    // The 409 must specifically be insufficient_inventory
    const failedRes = resA.status === 409 ? resA : resB;
    const failBody = await jsonBody<{ error: { code: string } }>(failedRes);
    expect(failBody.error.code).toBe('insufficient_inventory');

    // After the dust settles, exactly 0 units should be available
    const invAfter = await authedFetch(`/v1/inventory?sku=${seed.sku}`, seed.sk);
    const invAfterBody = await jsonBody<{
      items: Array<{ sku: string; available: number; reserved: number }>;
    }>(invAfter);
    const invItem = invAfterBody.items.find((i) => i.sku === seed.sku);
    expect(invItem?.available).toBe(0);
  });
});

describe('cartReplaceItems - reserved never goes negative after failure', () => {
  it('a failed replace (insufficient stock) does not leave reserved < 0', async () => {
    // Create a fresh cart and add 1 item (we're now at 0 available from above,
    // but this test file shares storage — the previous test left 0 available).
    // Add some stock first via the admin key, then try to over-reserve.

    // Restock 2 units so we can run this independently
    await authedFetch(`/v1/inventory/${seed.sku}/adjust`, seed.sk, {
      method: 'POST',
      body: JSON.stringify({ delta: 2, reason: 'restock' }),
    });

    const cartRes = await authedFetch('/v1/carts', seed.pk, {
      method: 'POST',
      body: JSON.stringify({ customer_email: 'replace-test@example.com' }),
    });
    const { id: cartId } = await jsonBody<{ id: string }>(cartRes);

    // Add 1 unit to cart (reserved +1)
    await authedFetch(`/v1/carts/${cartId}/items/add`, seed.pk, {
      method: 'POST',
      body: JSON.stringify({ sku: seed.sku, qty: 1 }),
    });

    // Now try to REPLACE with 9999 units (will fail) — old reservation should
    // be released and new reservation should fail, leaving reserved unchanged
    const invMid = await authedFetch(`/v1/inventory?sku=${seed.sku}`, seed.sk);
    const invMidBody = await jsonBody<{
      items: Array<{ sku: string; reserved: number; available: number }>;
    }>(invMid);
    const reservedBefore = invMidBody.items.find((i) => i.sku === seed.sku)?.reserved ?? 0;

    const replaceRes = await authedFetch(`/v1/carts/${cartId}/items`, seed.pk, {
      method: 'POST',
      body: JSON.stringify({ items: [{ sku: seed.sku, qty: 9999 }] }),
    });
    expect(replaceRes.status).toBe(409);

    // After a failed replace, reserved should be back to what it was before
    // (the old 1-unit reservation was released and the new reservation failed,
    //  so net change is 0 — effectively reserved goes back to reservedBefore - 1,
    //  since cartReplaceItems releases old items first then tries new ones)
    const invAfter = await authedFetch(`/v1/inventory?sku=${seed.sku}`, seed.sk);
    const invAfterBody = await jsonBody<{
      items: Array<{ sku: string; reserved: number; available: number }>;
    }>(invAfter);
    const reservedAfter = invAfterBody.items.find((i) => i.sku === seed.sku)?.reserved ?? 0;

    // reserved must be >= 0 (no negative values)
    expect(reservedAfter).toBeGreaterThanOrEqual(0);

    // The failed replace releases old items (the 1 unit we had), so reserved
    // should be reservedBefore - 1 (since old reservation was released and
    // new reservation failed)
    expect(reservedAfter).toBe(reservedBefore - 1);
  });
});
