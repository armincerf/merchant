/**
 * Test helpers for merchant integration tests.
 *
 * Each test file runs with isolated DO storage (vitest-pool-workers default).
 * Call `seedStore()` in a beforeAll to set up a public key + admin key,
 * one product, one variant, and inventory.
 */

import { SELF } from 'cloudflare:test';

// ── Key generation ──────────────────────────────────────────────────────────

function generateKey(prefix: 'pk' | 'sk'): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}_${hex}`;
}

async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function uuid(): string {
  return crypto.randomUUID();
}

// ── Seed result ─────────────────────────────────────────────────────────────

export interface SeedResult {
  pk: string;
  sk: string;
  productId: string;
  variantId: string;
  sku: string;
}

// ── Bootstrap store ─────────────────────────────────────────────────────────

/**
 * Seeds the store with two API keys (pk + sk), one product, one variant,
 * and 10 units of inventory. Designed to be called once per test file in
 * a `beforeAll` block.
 */
export async function seedStore(): Promise<SeedResult> {
  const pk = generateKey('pk');
  const sk = generateKey('sk');

  const pkHash = await hashKey(pk);
  const skHash = await hashKey(sk);

  const initRes = await SELF.fetch('http://example.com/v1/setup/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keys: [
        { id: uuid(), key_hash: pkHash, key_prefix: 'pk', role: 'public' },
        { id: uuid(), key_hash: skHash, key_prefix: 'sk', role: 'admin' },
      ],
    }),
  });

  if (!initRes.ok) {
    throw new Error(`seedStore: /v1/setup/init failed ${initRes.status}: ${await initRes.text()}`);
  }

  // Create a product
  const productRes = await SELF.fetch('http://example.com/v1/products', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sk}`,
    },
    body: JSON.stringify({ title: 'Test Widget', description: 'A widget for testing' }),
  });

  if (!productRes.ok) {
    throw new Error(`seedStore: create product failed ${productRes.status}: ${await productRes.text()}`);
  }

  const product = await productRes.json() as { id: string };

  // Create a variant with SKU
  const sku = `SKU-${Date.now()}`;
  const variantRes = await SELF.fetch(`http://example.com/v1/products/${product.id}/variants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sk}`,
    },
    body: JSON.stringify({ sku, title: 'Default Variant', price_cents: 1000 }),
  });

  if (!variantRes.ok) {
    throw new Error(`seedStore: create variant failed ${variantRes.status}: ${await variantRes.text()}`);
  }

  const variant = await variantRes.json() as { id: string };

  // Adjust inventory to 10 units
  const invRes = await SELF.fetch(`http://example.com/v1/inventory/${sku}/adjust`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sk}`,
    },
    body: JSON.stringify({ delta: 10, reason: 'restock' }),
  });

  if (!invRes.ok) {
    throw new Error(`seedStore: adjust inventory failed ${invRes.status}: ${await invRes.text()}`);
  }

  return { pk, sk, productId: product.id, variantId: variant.id, sku };
}

// ── Request helpers ──────────────────────────────────────────────────────────

export function authedFetch(
  url: string,
  key: string,
  init: RequestInit = {}
): Promise<Response> {
  return SELF.fetch(`http://example.com${url}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${key}`,
    },
  });
}

export function anonFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`http://example.com${url}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export async function jsonBody<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Response was not JSON (${res.status}): ${text}`);
  }
}
