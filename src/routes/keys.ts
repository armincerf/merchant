import { createRoute, z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { createApp } from '../lib/app';
import {
  adminOnly,
  authMiddleware,
  clearAuthMemo,
  generateApiKey,
  hashKey,
} from '../middleware/auth';
import {
  ApiKeyListResponse,
  CreateApiKeyBody,
  CreateApiKeyResponse,
  DeletedResponse,
  ErrorResponse,
} from '../schemas';
import { ApiError, now, uuid } from '../types';

const app = createApp();

app.use('*', authMiddleware);
app.use('*', adminOnly);

// ── GET /v1/keys ────────────────────────────────────────────────────────────

const listKeys = createRoute({
  method: 'get',
  path: '/',
  tags: ['API Keys'],
  summary: 'List API keys',
  description: 'List all API keys (id, key_prefix, role, created_at). Never returns key hashes.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { 'application/json': { schema: ApiKeyListResponse } },
      description: 'List of API keys',
    },
  },
});

app.openapi(listKeys, async (c) => {
  const db = getDb(c.var.db);
  const rows = await db.query<{ id: string; key_prefix: string; role: string; created_at: string }>(
    `SELECT id, key_prefix, role, created_at FROM api_keys ORDER BY created_at ASC`,
    [],
  );

  return c.json(
    {
      items: rows.map((r) => ({
        id: r.id,
        key_prefix: r.key_prefix,
        role: r.role as 'public' | 'admin',
        created_at: r.created_at,
      })),
    },
    200,
  );
});

// ── POST /v1/keys ───────────────────────────────────────────────────────────

const createKey = createRoute({
  method: 'post',
  path: '/',
  tags: ['API Keys'],
  summary: 'Create API key',
  description:
    'Generate a new API key. The full key is returned only in this response — store it immediately.',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateApiKeyBody } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: CreateApiKeyResponse } },
      description: 'Created API key (full key shown once)',
    },
    400: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Invalid request',
    },
  },
});

app.openapi(createKey, async (c) => {
  const { role } = c.req.valid('json');

  const prefix = role === 'admin' ? ('sk' as const) : ('pk' as const);
  const key = generateApiKey(prefix);
  const keyHash = await hashKey(key);
  const keyPrefix = `${key.slice(0, 8)}...`;
  const id = uuid();
  const createdAt = now();

  const db = getDb(c.var.db);
  await db.run(
    `INSERT INTO api_keys (id, key_hash, key_prefix, role, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, keyHash, keyPrefix, role, createdAt],
  );

  return c.json({ id, key, key_prefix: keyPrefix, role, created_at: createdAt }, 201);
});

// ── DELETE /v1/keys/:id ─────────────────────────────────────────────────────

const IdParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({
      param: { name: 'id', in: 'path' },
      example: '550e8400-e29b-41d4-a716-446655440000',
    }),
});

const deleteKey = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['API Keys'],
  summary: 'Revoke API key',
  description: 'Revoke an API key by id. Refuses to delete the last admin key to prevent lockout.',
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      content: { 'application/json': { schema: DeletedResponse } },
      description: 'Key revoked',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Key not found',
    },
    409: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Cannot delete the last admin key',
    },
  },
});

app.openapi(deleteKey, async (c) => {
  const { id } = c.req.valid('param');
  const db = getDb(c.var.db);

  // Atomically delete only if: not the last admin key (or not an admin key).
  // Single SQL avoids TOCTOU between check and delete.
  const result = await db.run(
    `DELETE FROM api_keys
     WHERE id = ?
       AND (
         role != 'admin'
         OR (SELECT COUNT(*) FROM api_keys WHERE role = 'admin') > 1
       )`,
    [id],
  );

  if (result.changes > 0) {
    // The auth middleware memoizes key→role lookups; drop the memo so the
    // revoked key stops working in this isolate immediately.
    clearAuthMemo();
    return c.json({ deleted: true as const }, 200);
  }

  // 0 changes — distinguish 404 from 409
  const [row] = await db.query<{ id: string; role: string }>(
    `SELECT id, role FROM api_keys WHERE id = ?`,
    [id],
  );

  if (!row) {
    throw ApiError.notFound('API key not found');
  }

  // Row exists but wasn't deleted — must be the last admin key
  throw ApiError.conflict('Cannot delete the last admin key');
});

export { app as keys };
