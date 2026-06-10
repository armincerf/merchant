import { createRoute, z } from '@hono/zod-openapi';
import Stripe from 'stripe';
import { getDb } from '../db';
import type { CartPayload, CheckoutReadyPayload, DomainError } from '../do';
import { createApp } from '../lib/app';
import { checkoutWindow, OPEN_CART_TTL_MINUTES } from '../lib/checkout-window';
import { getStripe, getStripeConfig } from '../lib/stripe';
import { authMiddleware } from '../middleware/auth';
import { idempotencyMiddleware } from '../middleware/idempotency';
import {
  AddCartItemBody,
  AddCartItemsBody,
  ApplyDiscountBody,
  ApplyDiscountResponse,
  CartIdParam,
  CartResponse,
  CartTotals,
  CheckoutBody,
  CheckoutResponse,
  CreateCartBody,
  ErrorResponse,
} from '../schemas';
import { ApiError, isValidEmail, now, uuid } from '../types';
import { calculateDiscount, type Discount, validateDiscount } from './discounts';

const RemoveDiscountResponse = z
  .object({
    discount: z.null(),
    totals: CartTotals,
  })
  .openapi('RemoveDiscountResponse');

const app = createApp();

app.use('*', authMiddleware);

/** Type guard for domain errors returned from DO methods. */
function isDomainError(v: CartPayload | DomainError | CheckoutReadyPayload): v is DomainError {
  return 'code' in v && 'message' in v;
}

const getCart = createRoute({
  method: 'get',
  path: '/{cartId}',
  tags: ['Checkout'],
  summary: 'Get cart by ID',
  request: { params: CartIdParam },
  responses: {
    200: { content: { 'application/json': { schema: CartResponse } }, description: 'Cart details' },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Cart not found',
    },
  },
});

app.openapi(getCart, async (c) => {
  const { cartId } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
  if (!cart) throw ApiError.notFound('Cart not found');

  const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);

  return c.json(
    {
      id: cart.id,
      status: cart.status,
      currency: cart.currency,
      customer_email: cart.customer_email,
      items: items.map((i) => ({
        sku: i.sku,
        title: i.title,
        qty: i.qty,
        unit_price_cents: i.unit_price_cents,
      })),
      expires_at: cart.expires_at,
      stripe_checkout_session_id: cart.stripe_checkout_session_id,
    },
    200,
  );
});

const createCart = createRoute({
  method: 'post',
  path: '/',
  tags: ['Checkout'],
  summary: 'Create a new cart',
  middleware: [idempotencyMiddleware()] as const,
  request: { body: { content: { 'application/json': { schema: CreateCartBody } } } },
  responses: {
    200: { content: { 'application/json': { schema: CartResponse } }, description: 'Created cart' },
    400: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Invalid email',
    },
  },
});

app.openapi(createCart, async (c) => {
  const { customer_email } = c.req.valid('json');

  if (!isValidEmail(customer_email)) {
    throw ApiError.invalidRequest('A valid customer_email is required');
  }

  const db = getDb(c.var.db);
  const id = uuid();
  const expiresAt = new Date(Date.now() + OPEN_CART_TTL_MINUTES * 60 * 1000).toISOString();

  await db.run(`INSERT INTO carts (id, customer_email, expires_at) VALUES (?, ?, ?)`, [
    id,
    customer_email,
    expiresAt,
  ]);

  return c.json(
    {
      id,
      status: 'open' as const,
      currency: 'USD',
      customer_email,
      items: [],
      discount: null,
      totals: {
        subtotal_cents: 0,
        discount_cents: 0,
        shipping_cents: 0,
        tax_cents: 0,
        total_cents: 0,
      },
      expires_at: expiresAt,
    },
    200,
  );
});

const addCartItems = createRoute({
  method: 'post',
  path: '/{cartId}/items',
  tags: ['Checkout'],
  summary: 'Add items to cart',
  description: 'Replaces existing cart items with the provided items',
  request: {
    params: CartIdParam,
    body: { content: { 'application/json': { schema: AddCartItemsBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: CartResponse } }, description: 'Updated cart' },
    400: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Invalid request',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Cart or SKU not found',
    },
    409: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Cart is not open',
    },
  },
});

app.openapi(addCartItems, async (c) => {
  const { cartId } = c.req.valid('param');
  const { items } = c.req.valid('json');

  const result = await c.var.db.cartReplaceItems(cartId, items);

  if (isDomainError(result)) {
    switch (result.code) {
      case 'cart_not_found':
        throw ApiError.notFound('Cart not found');
      case 'cart_not_open':
        throw ApiError.conflict('Cart is not open');
      case 'sku_not_found':
        throw ApiError.notFound(result.message);
      case 'sku_not_active':
        throw ApiError.invalidRequest(result.message);
      case 'insufficient_inventory':
        throw ApiError.insufficientInventory(result.details.sku);
      default:
        throw ApiError.invalidRequest('Failed to update cart');
    }
  }

  return c.json(result as any, 200);
});

// === Incremental add/remove with atomic reservation ===

const addCartItem = createRoute({
  method: 'post',
  path: '/{cartId}/items/add',
  tags: ['Checkout'],
  summary: 'Add or remove a single item with atomic inventory reservation',
  description:
    'Positive qty adds items (reserves inventory). Negative qty removes items (releases reservation).',
  request: {
    params: CartIdParam,
    body: { content: { 'application/json': { schema: AddCartItemBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: CartResponse } }, description: 'Updated cart' },
    400: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Invalid request',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Cart or SKU not found',
    },
    409: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Insufficient inventory or cart not open',
    },
  },
});

app.openapi(addCartItem, async (c) => {
  const { cartId } = c.req.valid('param');
  const { sku, qty } = c.req.valid('json');

  if (qty === 0) throw ApiError.invalidRequest('qty must be non-zero');

  const result = await c.var.db.cartAddItem(cartId, sku, qty);

  if (isDomainError(result)) {
    switch (result.code) {
      case 'cart_not_found':
        throw ApiError.notFound('Cart not found');
      case 'cart_not_open':
        throw new ApiError('cart_not_open', 409, 'Cart is not open');
      case 'sku_not_found':
        throw ApiError.notFound(result.message);
      case 'sku_not_active':
        throw ApiError.invalidRequest(result.message);
      case 'insufficient_inventory':
        throw ApiError.insufficientInventory(result.details.sku);
      default:
        throw ApiError.invalidRequest('Failed to update cart');
    }
  }

  // Broadcast inventory update for affected SKU
  c.var.db.broadcast({
    type: 'inventory.updated',
    data: { sku },
    timestamp: new Date().toISOString(),
  });

  return c.json(result as any, 200);
});

const checkoutCart = createRoute({
  method: 'post',
  path: '/{cartId}/checkout',
  tags: ['Checkout'],
  summary: 'Initiate Stripe checkout',
  description: 'Creates a Stripe checkout session and returns the URL',
  middleware: [idempotencyMiddleware()] as const,
  request: {
    params: CartIdParam,
    body: { content: { 'application/json': { schema: CheckoutBody } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: CheckoutResponse } },
      description: 'Checkout URL',
    },
    400: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Invalid request or insufficient inventory',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Cart not found',
    },
    409: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Cart is not open',
    },
  },
});

app.openapi(checkoutCart, async (c) => {
  const { cartId } = c.req.valid('param');
  const { success_url, cancel_url, collect_shipping, shipping_countries, shipping_options } =
    c.req.valid('json');

  const { secretKey: stripeSecretKey } = await getStripeConfig(getDb(c.var.db), c.env);
  if (!stripeSecretKey) {
    throw ApiError.invalidRequest('Stripe not connected. POST /v1/setup/stripe first.');
  }

  // Single atomic RPC: flip status, verify inventory, reserve discount
  const checkoutReady = await c.var.db.cartBeginCheckout(cartId);

  if (isDomainError(checkoutReady)) {
    switch (checkoutReady.code) {
      case 'cart_not_found':
        throw ApiError.notFound('Cart not found');
      case 'cart_not_open':
        throw ApiError.conflict('Cart is not open');
      case 'cart_empty':
        throw ApiError.invalidRequest('Cart is empty');
      case 'insufficient_inventory':
        throw ApiError.insufficientInventory(checkoutReady.details.sku);
      case 'discount_invalid':
        throw ApiError.invalidRequest(checkoutReady.message);
      default:
        throw ApiError.invalidRequest('Failed to initiate checkout. Please try again.');
    }
  }

  const { cart, items, discount } = checkoutReady;

  const discountAmountCents = discount?.amount_cents ?? 0;
  const discountReserved = discount !== null && discount.usage_limit !== null;

  const releaseReservedDiscount = async () => {
    if (discountReserved && discount) {
      await c.var.db.cartRevertCheckout(cartId, discount.id);
    } else {
      await c.var.db.cartRevertCheckout(cartId);
    }
  };

  const stripe = getStripe(stripeSecretKey);

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = items.map((item) => ({
    price_data: {
      currency: 'usd',
      product_data: { name: item.title },
      unit_amount: item.unit_price_cents,
    },
    quantity: item.qty,
  }));

  let stripeCouponId: string | null = null;
  if (discount && discountAmountCents > 0) {
    const needsOnTheFlyCoupon = discount.type === 'percentage' && discount.max_discount_cents;

    if (discount.stripe_coupon_id && !needsOnTheFlyCoupon) {
      stripeCouponId = discount.stripe_coupon_id;
    } else if (stripeSecretKey) {
      try {
        const couponParams: Stripe.CouponCreateParams = {
          duration: 'once',
          metadata: { merchant_discount_id: discount.id },
        };

        if (discount.type === 'percentage' && discount.max_discount_cents) {
          couponParams.amount_off = discountAmountCents;
          couponParams.currency = 'usd';
        } else if (discount.type === 'percentage') {
          couponParams.percent_off = discount.value;
        } else {
          couponParams.amount_off = discount.value;
          couponParams.currency = 'usd';
        }

        const coupon = await stripe.coupons.create(couponParams);
        stripeCouponId = coupon.id;
      } catch (err: any) {
        await releaseReservedDiscount();
        console.error(`Failed to create Stripe coupon for discount: ${err.message}`);
        throw ApiError.invalidRequest(
          'Failed to apply discount. Please try again or remove the discount and proceed.',
        );
      }
    }
  }

  const defaultShippingOptions: Stripe.Checkout.SessionCreateParams.ShippingOption[] = [
    {
      shipping_rate_data: {
        type: 'fixed_amount',
        fixed_amount: { amount: 0, currency: 'usd' },
        display_name: 'Standard Shipping',
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 5 },
          maximum: { unit: 'business_day', value: 7 },
        },
      },
    },
  ];

  // One instant drives both the Stripe session expiry and the cart expiry:
  // the cron releases inventory for carts past expires_at, so the session
  // must stop being payable at that same moment (merchant-wie).
  const expiry = checkoutWindow();

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: cart.customer_email,
      automatic_tax: { enabled: true },
      expires_at: expiry.stripeExpiresAt,
      ...(collect_shipping && {
        shipping_address_collection: {
          allowed_countries:
            shipping_countries as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[],
        },
        shipping_options: shipping_options ?? defaultShippingOptions,
      }),
      line_items: lineItems,
      ...(stripeCouponId && { discounts: [{ coupon: stripeCouponId }] }),
      success_url,
      cancel_url,
      metadata: {
        cart_id: cartId,
        ...(discount && {
          discount_id: discount.id,
          discount_code: discount.code || '',
          discount_type: discount.type,
        }),
      },
    });
  } catch {
    await releaseReservedDiscount();
    throw ApiError.invalidRequest('Payment processing error. Please try again.');
  }

  const db = getDb(c.var.db);
  await db.run(
    `UPDATE carts SET stripe_checkout_session_id = ?, discount_amount_cents = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
    [session.id, discountAmountCents, expiry.cartExpiresAt, now(), cartId],
  );

  return c.json(
    {
      checkout_url: session.url!,
      stripe_checkout_session_id: session.id,
    },
    200,
  );
});

const applyDiscount = createRoute({
  method: 'post',
  path: '/{cartId}/apply-discount',
  tags: ['Checkout'],
  summary: 'Apply discount code to cart',
  request: {
    params: CartIdParam,
    body: { content: { 'application/json': { schema: ApplyDiscountBody } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ApplyDiscountResponse } },
      description: 'Discount applied',
    },
    400: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Invalid discount',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Cart or discount not found',
    },
    409: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Cart is not open',
    },
  },
});

app.openapi(applyDiscount, async (c) => {
  const { cartId } = c.req.valid('param');
  const { code } = c.req.valid('json');
  const db = getDb(c.var.db);

  const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
  if (!cart) throw ApiError.notFound('Cart not found');
  if (cart.status !== 'open') throw ApiError.conflict('Cart is not open');

  const normalizedCode = code.toUpperCase().trim();

  const [discount] = await db.query<any>(`SELECT * FROM discounts WHERE code = ?`, [
    normalizedCode,
  ]);
  if (!discount) throw ApiError.notFound('Discount code not found');

  const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);
  if (items.length === 0) throw ApiError.invalidRequest('Cart is empty');

  const subtotalCents = items.reduce((sum: number, item: any) => {
    return sum + item.unit_price_cents * item.qty;
  }, 0);

  await validateDiscount(db, discount as Discount, subtotalCents, cart.customer_email);
  const discountAmountCents = calculateDiscount(discount as Discount, subtotalCents);

  await db.run(
    `UPDATE carts SET discount_code = ?, discount_id = ?, discount_amount_cents = ? WHERE id = ?`,
    [discount.code, discount.id, discountAmountCents, cartId],
  );

  return c.json(
    {
      discount: {
        code: discount.code,
        type: discount.type as 'percentage' | 'fixed_amount',
        amount_cents: discountAmountCents,
      },
      totals: {
        subtotal_cents: subtotalCents,
        discount_cents: discountAmountCents,
        shipping_cents: 0,
        tax_cents: 0,
        total_cents: subtotalCents - discountAmountCents,
      },
    },
    200,
  );
});

const removeDiscount = createRoute({
  method: 'delete',
  path: '/{cartId}/discount',
  tags: ['Checkout'],
  summary: 'Remove discount from cart',
  request: { params: CartIdParam },
  responses: {
    200: {
      content: { 'application/json': { schema: RemoveDiscountResponse } },
      description: 'Discount removed',
    },
    404: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Cart not found',
    },
    409: {
      content: { 'application/json': { schema: ErrorResponse } },
      description: 'Cart is not open',
    },
  },
});

app.openapi(removeDiscount, async (c) => {
  const { cartId } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
  if (!cart) throw ApiError.notFound('Cart not found');
  if (cart.status !== 'open') throw ApiError.conflict('Cart is not open');

  await db.run(
    `UPDATE carts SET discount_code = NULL, discount_id = NULL, discount_amount_cents = 0 WHERE id = ?`,
    [cartId],
  );

  const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);
  const subtotalCents = items.reduce((sum: number, item: any) => {
    return sum + item.unit_price_cents * item.qty;
  }, 0);

  return c.json(
    {
      discount: null,
      totals: {
        subtotal_cents: subtotalCents,
        discount_cents: 0,
        shipping_cents: 0,
        tax_cents: 0,
        total_cents: subtotalCents,
      },
    },
    200,
  );
});

export { app as checkout };
