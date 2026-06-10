/**
 * Global per-test reset of in-isolate memos.
 *
 * vitest-pool-workers rolls back storage (DO SQLite + Cache API) between
 * tests, but module-level state in the worker survives, because every test in
 * a file shares one isolate. The auth and version memos are module-level by
 * design — in production an isolate never sees its database roll backwards.
 * Tests do exactly that, so a memoized version counter could point at a
 * cache entry from a previous test. Clearing both memos before each test
 * restores the invariant the memos rely on.
 */

import { beforeEach } from 'vitest';
import { clearAuthMemo } from '../src/middleware/auth';
import { clearVersionMemo } from '../src/middleware/cache';

beforeEach(() => {
  clearAuthMemo();
  clearVersionMemo();
});
