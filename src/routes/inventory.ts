import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import { checkLowInventory } from '../lib/webhooks';
import {
  InventoryQuery,
  InventoryListResponse,
  InventoryItem,
  SkuParam,
  AdjustInventoryBody,
  ErrorResponse,
} from '../schemas';

const app = new OpenAPIHono<HonoEnv>();

app.use('*', authMiddleware);

const listInventory = createRoute({
  method: 'get',
  path: '/',
  tags: ['Inventory'],
  summary: 'List inventory levels',
  description: 'List all inventory levels with pagination, or get a single SKU by query param',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { query: InventoryQuery },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: InventoryListResponse,
        },
      },
      description: 'List of inventory levels',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'SKU not found (when querying single SKU)',
    },
  },
});

app.openapi(listInventory, async (c) => {
  const { sku, limit: limitStr, cursor, low_stock } = c.req.valid('query');
  const db = getDb(c.var.db);

  if (sku) {
    const [level] = await db.query<any>(
      `SELECT i.*, v.title as variant_title, p.title as product_title
       FROM inventory i
       LEFT JOIN variants v ON i.sku = v.sku
       LEFT JOIN products p ON v.product_id = p.id
       WHERE i.sku = ?`,
      [sku]
    );

    if (!level) throw ApiError.notFound('SKU not found');

    return c.json({
      items: [{
        sku: level.sku,
        on_hand: level.on_hand,
        reserved: level.reserved,
        available: level.on_hand - level.reserved,
        variant_title: level.variant_title,
        product_title: level.product_title,
      }],
      pagination: { has_more: false, next_cursor: null },
    }, 200);
  }

  const limit = Math.min(parseInt(limitStr || '100'), 500);
  const lowStock = low_stock === 'true';

  let query = `SELECT i.*, v.title as variant_title, p.title as product_title
     FROM inventory i
     LEFT JOIN variants v ON i.sku = v.sku
     LEFT JOIN products p ON v.product_id = p.id`;
  const params: unknown[] = [];

  const conditions: string[] = [];
  if (lowStock) {
    conditions.push(`(i.on_hand - i.reserved) <= 10`);
  }
  if (cursor) {
    conditions.push(`i.sku > ?`);
    params.push(cursor);
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  query += ` ORDER BY i.sku LIMIT ?`;
  params.push(limit + 1);

  const items = await db.query<any>(query, params);

  const hasMore = items.length > limit;
  if (hasMore) items.pop();

  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].sku : null;

  return c.json({
    items: items.map((i) => ({
      sku: i.sku,
      on_hand: i.on_hand,
      reserved: i.reserved,
      available: i.on_hand - i.reserved,
      variant_title: i.variant_title,
      product_title: i.product_title,
    })),
    pagination: {
      has_more: hasMore,
      next_cursor: nextCursor,
    },
  }, 200);
});

const adjustInventory = createRoute({
  method: 'post',
  path: '/{sku}/adjust',
  tags: ['Inventory'],
  summary: 'Adjust inventory level',
  description: 'Add or subtract inventory for a SKU with a reason',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    params: SkuParam,
    body: { content: { 'application/json': { schema: AdjustInventoryBody } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: InventoryItem } },
      description: 'Updated inventory level',
    },
    400: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Invalid request (e.g., would go below 0)',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'SKU not found',
    },
  },
});

app.openapi(adjustInventory, async (c) => {
  const { sku } = c.req.valid('param');
  const { delta, reason } = c.req.valid('json');
  const db = getDb(c.var.db);

  const [existing] = await db.query<any>(`SELECT * FROM inventory WHERE sku = ?`, [sku]);
  if (!existing) throw ApiError.notFound('SKU not found');

  if (delta < 0 && existing.on_hand + delta < 0) {
    throw ApiError.invalidRequest(
      `Cannot reduce inventory below 0. Current on_hand: ${existing.on_hand}`
    );
  }

  await db.run(
    `UPDATE inventory SET on_hand = on_hand + ?, updated_at = ? WHERE sku = ?`,
    [delta, now(), sku]
  );

  await db.run(
    `INSERT INTO inventory_logs (id, sku, delta, reason) VALUES (?, ?, ?, ?)`,
    [uuid(), sku, delta, reason]
  );

  const [level] = await db.query<any>(`SELECT * FROM inventory WHERE sku = ?`, [sku]);

  const available = level.on_hand - level.reserved;

  await checkLowInventory(c.var.db, c.executionCtx, sku, available);

  return c.json({
    sku: level.sku,
    on_hand: level.on_hand,
    reserved: level.reserved,
    available,
  }, 200);
});

export { app as inventory };
