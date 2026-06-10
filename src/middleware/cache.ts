import { createMiddleware } from 'hono/factory';
import type { AuthContext, DOStub, HonoEnv } from '../types';

// ============================================================
// EDGE CACHE FOR PUBLIC CATALOG READS
// ============================================================
// Public-role (and anonymous) catalog GETs return the same bytes for every
// caller, so they are cached in the per-colo Cache API under a synthetic URL
// that embeds a version counter. SQLite triggers (002-cache-versions) bump
// the counter on every write to products/variants/product_images (catalog)
// and inventory, so a write rotates the key and stale entries are never
// matched again — the Cache API has no global purge, key rotation IS the
// invalidation. The TTL is only a backstop that lets superseded entries fall
// out of each colo.
//
// The counters themselves are memoized per isolate for a few seconds so a
// cache hit costs zero DO round trips. Mutations routed through this isolate
// clear the memo (versionMemoInvalidator below), so a writer reads its own
// write on the very next request; other isolates and colos converge within
// VERSION_MEMO_TTL_MS.
//
// On workers.dev (no zone) caches.default never matches, so every request
// falls through to the DO — correct, just uncached.

export const CACHE_TTL_SECONDS = 60;
export const VERSION_MEMO_TTL_MS = 5_000;

export type VersionKind = 'catalog' | 'inventory';

type Versions = Record<VersionKind, string>;

let versionMemo: { value: Versions; expiresAt: number } | null = null;

/** Forget the memoized version counters for this isolate. */
export function clearVersionMemo(): void {
  versionMemo = null;
}

async function getVersions(db: DOStub): Promise<Versions> {
  if (versionMemo && versionMemo.expiresAt > Date.now()) {
    return versionMemo.value;
  }

  const rows = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM config WHERE key IN ('catalog_version', 'inventory_version')`,
    [],
  );
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const value: Versions = {
    catalog: byKey.get('catalog_version') ?? '0',
    inventory: byKey.get('inventory_version') ?? '0',
  };

  versionMemo = { value, expiresAt: Date.now() + VERSION_MEMO_TTL_MS };
  return value;
}

function getDefaultCache(): Cache | undefined {
  return (globalThis.caches as unknown as { default?: Cache } | undefined)?.default;
}

/**
 * Serve public GETs from the edge cache, keyed on URL + version counter.
 * Admin and OAuth reads bypass the cache entirely (always fresh); anonymous
 * and public-key reads share one entry because their responses are identical.
 */
export function publicCache(kind: VersionKind) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    if (c.req.method !== 'GET') {
      return next();
    }

    const role = (c.var.auth as AuthContext | undefined)?.role;
    if (role && role !== 'public') {
      return next();
    }

    const cache = getDefaultCache();
    if (!cache) {
      return next();
    }

    const version = (await getVersions(c.var.db))[kind];
    const url = new URL(c.req.url);
    url.searchParams.sort();
    const key = `${url.origin}/__cache/${kind}/v${version}${url.pathname}${url.search}`;

    const hit = await cache.match(key);
    if (hit) {
      const res = new Response(hit.body, hit);
      // The stored Cache-Control is for the edge cache only; clients keep
      // getting uncacheable responses, same as before this middleware.
      res.headers.delete('Cache-Control');
      res.headers.set('X-Cache', 'HIT');
      return res;
    }

    await next();

    if (c.res.status !== 200) {
      return;
    }

    const copy = c.res.clone();
    const headers = new Headers(copy.headers);
    headers.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`);
    headers.delete('Set-Cookie'); // cache.put silently refuses Set-Cookie responses
    await cache.put(key, new Response(copy.body, { status: 200, headers }));
    c.res.headers.set('X-Cache', 'MISS');
  });
}

/**
 * Route prefixes whose non-GET requests can change catalog or inventory
 * state (directly or via DO domain methods like checkout reservation and
 * order finalization). Scoped to these so high-volume writes that cannot
 * touch the catalog — analytics events above all — keep the memo warm.
 */
const MUTATING_PREFIXES = [
  '/v1/products',
  '/v1/inventory',
  '/v1/carts',
  '/v1/orders',
  '/v1/webhooks',
  '/v1/setup',
  '/ucp',
];

/**
 * Clear the version memo after any request that may have written catalog or
 * inventory data, so the next read in this isolate sees the bumped counter
 * immediately instead of after VERSION_MEMO_TTL_MS.
 */
export const versionMemoInvalidator = createMiddleware<HonoEnv>(async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }
  if (!MUTATING_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))) {
    return next();
  }

  try {
    await next();
  } finally {
    clearVersionMemo();
  }
});
