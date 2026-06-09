import { createRoute } from '@hono/zod-openapi';
import { getDb } from '../db';
import { createApp } from '../lib/app';
import { parseCompositeCursor } from '../lib/pagination';
import { getStripe } from '../lib/stripe';
import { dispatchWebhooks, type WebhookEventType } from '../lib/webhooks';
import { adminOnly, authMiddleware } from '../middleware/auth';
import { idempotencyMiddleware } from '../middleware/idempotency';
import {
  CreateTestOrderBody,
  ErrorResponse,
  OrderIdParam,
  OrderListResponse,
  OrderQuery,
  OrderResponse,
  RefundOrderBody,
  RefundResponse,
  UpdateOrderBody,
} from '../schemas';
import { ApiError, now, uuid } from '../types';

const app = createApp();

app.use('*', authMiddleware);

const listOrders = createRoute({
  method: 'get',
  path: '/',
  tags: ['Orders'],
  summary: 'List orders',
  description: 'List orders with pagination and optional filters by status and email',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { query: OrderQuery },
  responses: {
    200: {
      content: { 'application/json': { schema: OrderListResponse } },
      description: 'List of orders',
    },
  },
});

app.openapi(listOrders, async (c) => {
  const db = getDb(c.var.db);
  const { limit: limitStr, cursor, status, email } = c.req.valid('query');
  const limit = Math.min(parseInt(limitStr || '20', 10), 100);

  let query = `SELECT * FROM orders WHERE 1=1`;
  const params: unknown[] = [];

  if (status) {
    query += ` AND status = ?`;
    params.push(status);
  }

  if (email) {
    query += ` AND customer_email = ?`;
    params.push(email);
  }

  if (cursor) {
    const { date: cursorDate, id: cursorId } = parseCompositeCursor(cursor);
    query += ` AND (created_at < ? OR (created_at = ? AND id < ?))`;
    params.push(cursorDate, cursorDate, cursorId);
  }

  query += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
  params.push(limit + 1);

  const orderList = await db.query<any>(query, params);

  const hasMore = orderList.length > limit;
  if (hasMore) orderList.pop();

  const orderIds = orderList.map((o) => o.id);
  const itemsByOrder: Record<string, any[]> = {};

  if (orderIds.length > 0) {
    const placeholders = orderIds.map(() => '?').join(',');
    const allItems = await db.query<any>(
      `SELECT * FROM order_items WHERE order_id IN (${placeholders})`,
      orderIds,
    );

    for (const item of allItems) {
      if (!itemsByOrder[item.order_id]) {
        itemsByOrder[item.order_id] = [];
      }
      itemsByOrder[item.order_id].push(item);
    }
  }

  const items = orderList.map((order) => formatOrder(order, itemsByOrder[order.id] || []));
  const lastItem = orderList.length > 0 ? orderList[orderList.length - 1] : null;
  const nextCursor = hasMore && lastItem ? `${lastItem.created_at}|${lastItem.id}` : null;

  return c.json({ items, pagination: { has_more: hasMore, next_cursor: nextCursor } }, 200);
});

const getOrder = createRoute({
  method: 'get',
  path: '/{orderId}',
  tags: ['Orders'],
  summary: 'Get order by ID',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { params: OrderIdParam },
  responses: {
    200: {
      content: { 'application/json': { schema: OrderResponse } },
      description: 'Order details',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Order not found',
    },
  },
});

app.openapi(getOrder, async (c) => {
  const { orderId } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');

  const orderItems = await db.query<any>(`SELECT * FROM order_items WHERE order_id = ?`, [
    order.id,
  ]);

  return c.json(formatOrder(order, orderItems), 200);
});

const updateOrder = createRoute({
  method: 'patch',
  path: '/{orderId}',
  tags: ['Orders'],
  summary: 'Update order status/tracking',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    params: OrderIdParam,
    body: { content: { 'application/json': { schema: UpdateOrderBody } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: OrderResponse } },
      description: 'Updated order',
    },
    400: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Invalid request',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Order not found',
    },
  },
});

app.openapi(updateOrder, async (c) => {
  const { orderId } = c.req.valid('param');
  const { status, tracking_number, tracking_url } = c.req.valid('json');
  const db = getDb(c.var.db);

  const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');

  const updates: string[] = [];
  const params: unknown[] = [];

  if (status !== undefined) {
    updates.push('status = ?');
    params.push(status);

    if (status === 'shipped' && !order.shipped_at) {
      updates.push('shipped_at = ?');
      params.push(now());
    }
  }

  if (tracking_number !== undefined) {
    updates.push('tracking_number = ?');
    params.push(tracking_number || null);
  }

  if (tracking_url !== undefined) {
    updates.push('tracking_url = ?');
    params.push(tracking_url || null);
  }

  if (updates.length === 0) {
    throw ApiError.invalidRequest('No fields to update');
  }

  params.push(orderId);
  await db.run(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`, params);

  const [updated] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  const orderItems = await db.query<any>(`SELECT * FROM order_items WHERE order_id = ?`, [orderId]);
  const formattedOrder = formatOrder(updated, orderItems);

  if (status !== undefined && status !== order.status) {
    let eventType: WebhookEventType = 'order.updated';
    if (status === 'shipped') eventType = 'order.shipped';

    await dispatchWebhooks(c.var.db, c.executionCtx, eventType, {
      order: formattedOrder,
      previous_status: order.status,
    });
  }

  return c.json(formattedOrder, 200);
});

const refundOrder = createRoute({
  method: 'post',
  path: '/{orderId}/refund',
  tags: ['Orders'],
  summary: 'Refund an order',
  description: 'Full or partial refund via Stripe',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly, idempotencyMiddleware()] as const,
  request: {
    params: OrderIdParam,
    body: { content: { 'application/json': { schema: RefundOrderBody } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: RefundResponse } },
      description: 'Refund result',
    },
    400: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Invalid request or Stripe error',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Order not found',
    },
    409: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Already refunded',
    },
  },
});

app.openapi(refundOrder, async (c) => {
  const { orderId } = c.req.valid('param');
  const { amount_cents } = c.req.valid('json');

  const stripeSecretKey = c.get('auth').stripeSecretKey;
  if (!stripeSecretKey) throw ApiError.invalidRequest('Stripe not connected');

  const db = getDb(c.var.db);

  const [order] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status === 'refunded') throw ApiError.conflict('Order already refunded');
  if (!order.stripe_payment_intent_id) {
    throw ApiError.invalidRequest('Cannot refund test orders (no Stripe payment)');
  }

  const stripe = getStripe(stripeSecretKey);

  try {
    const refund = await stripe.refunds.create({
      payment_intent: order.stripe_payment_intent_id,
      amount: amount_cents,
    });

    await db.run(
      `INSERT INTO refunds (id, order_id, stripe_refund_id, amount_cents, status) VALUES (?, ?, ?, ?, ?)`,
      [uuid(), order.id, refund.id, refund.amount, refund.status ?? 'succeeded'],
    );

    if (!amount_cents || amount_cents >= order.total_cents) {
      await db.run(`UPDATE orders SET status = 'refunded' WHERE id = ?`, [orderId]);

      const [refundedOrder] = await db.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
      const orderItems = await db.query<any>(`SELECT * FROM order_items WHERE order_id = ?`, [
        orderId,
      ]);

      await dispatchWebhooks(c.var.db, c.executionCtx, 'order.refunded', {
        order: formatOrder(refundedOrder, orderItems),
        refund: { stripe_refund_id: refund.id, amount_cents: refund.amount },
      });
    }

    return c.json({ stripe_refund_id: refund.id, status: refund.status ?? 'succeeded' }, 200);
  } catch (e: any) {
    throw ApiError.stripeError(e.message || 'Refund failed');
  }
});

const createTestOrder = createRoute({
  method: 'post',
  path: '/test',
  tags: ['Orders'],
  summary: 'Create test order',
  description: 'Creates an order without Stripe payment (for testing)',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    body: { content: { 'application/json': { schema: CreateTestOrderBody } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: OrderResponse } },
      description: 'Created order',
    },
    400: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Invalid request',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'SKU or discount not found',
    },
  },
});

app.openapi(createTestOrder, async (c) => {
  const { customer_email, items, discount_code } = c.req.valid('json');

  const result = await c.var.db.createTestOrder({
    customerEmail: customer_email,
    items,
    discountCode: discount_code ?? null,
  });

  if (!result.ok) {
    switch (result.code) {
      case 'sku_not_found':
        throw ApiError.notFound(result.message);
      case 'insufficient_inventory':
        throw ApiError.insufficientInventory(result.details.sku);
      case 'discount_invalid':
        // Map to appropriate HTTP error
        if (result.message === 'Discount code not found') {
          throw ApiError.notFound('Discount code not found');
        }
        throw ApiError.invalidRequest(result.message);
      default:
        throw ApiError.invalidRequest('Failed to create test order');
    }
  }

  return c.json(formatOrder(result.order, result.items), 200);
});

function formatOrder(order: any, items: any[]) {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    customer_email: order.customer_email,
    customer_id: order.customer_id || null,
    shipping: {
      name: order.shipping_name || null,
      phone: order.shipping_phone || null,
      address: order.ship_to ? JSON.parse(order.ship_to) : null,
    },
    amounts: {
      subtotal_cents: order.subtotal_cents,
      discount_cents: order.discount_amount_cents || 0,
      tax_cents: order.tax_cents,
      shipping_cents: order.shipping_cents,
      total_cents: order.total_cents,
      currency: order.currency,
    },
    discount: order.discount_code
      ? { code: order.discount_code, amount_cents: order.discount_amount_cents || 0 }
      : null,
    tracking: {
      number: order.tracking_number,
      url: order.tracking_url,
      shipped_at: order.shipped_at,
    },
    stripe: {
      checkout_session_id: order.stripe_checkout_session_id,
      payment_intent_id: order.stripe_payment_intent_id,
    },
    items: items.map((i) => ({
      sku: i.sku,
      title: i.title,
      qty: i.qty,
      unit_price_cents: i.unit_price_cents,
    })),
    created_at: order.created_at,
  };
}

export { app as orders };
