import type { Context } from 'hono';
import { Hono } from 'hono';
import type Stripe from 'stripe';
import { getDb } from '../db';
import { getStripe, getStripeConfig } from '../lib/stripe';
import { dispatchWebhooks } from '../lib/webhooks';
import { ApiError, type HonoEnv } from '../types';
import { handleUCPStripeWebhook } from './ucp';

// ============================================================
// WEBHOOK ROUTES
// ============================================================

export const webhooks = new Hono<HonoEnv>();

// POST /v1/webhooks/stripe
webhooks.post('/stripe', async (c) => {
  const signature = c.req.header('stripe-signature');
  const body = await c.req.text();

  if (!signature) throw ApiError.invalidRequest('Missing stripe-signature header');

  const db = getDb(c.var.db);

  // Same credential source as checkout/refunds: config table, env override.
  const stripeConfig = await getStripeConfig(db, c.env);
  if (!stripeConfig.secretKey) {
    throw ApiError.invalidRequest('Stripe not configured');
  }
  if (!stripeConfig.webhookSecret) {
    throw ApiError.invalidRequest('Stripe webhook secret not configured');
  }

  // Verify signature
  const stripe = getStripe(stripeConfig.secretKey);
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, stripeConfig.webhookSecret);
  } catch (e: any) {
    throw new ApiError('webhook_signature_invalid', 400, e.message);
  }

  // Atomically claim this Stripe event — INSERT OR IGNORE on the unique stripe_event_id column.
  // If another concurrent delivery already inserted the row, changes=0 → claimed=false → skip.
  const { claimed } = await c.var.db.claimEvent(
    event.id,
    event.type,
    JSON.stringify(event.data.object),
  );
  if (!claimed) return c.json({ ok: true });

  // Process the event. On unexpected errors, release the claim so Stripe's retry can reprocess.
  try {
    if (event.type === 'checkout.session.expired') {
      await handleCheckoutSessionExpired(c, event.data.object as Stripe.Checkout.Session);
    }

    if (event.type === 'checkout.session.completed') {
      await handleCheckoutSessionCompleted(c, stripe, event.data.object as Stripe.Checkout.Session);
    }
  } catch (err) {
    // Unexpected processing error — release the claim so Stripe's retry can reprocess.
    await c.var.db.releaseEventClaim(event.id);
    throw err;
  }

  return c.json({ ok: true });
});

async function handleCheckoutSessionExpired(
  c: Context<HonoEnv>,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const cartId = session.metadata?.cart_id;
  if (!cartId) return;

  // Release inventory reservations and discount usage for the abandoned cart.
  // releaseAbandonedCheckout is idempotent: if the cart was already finalized
  // (status='expired' via finalizeOrderFromCart) or already released, this is
  // a no-op, so double-processing is safe.
  await c.var.db.releaseAbandonedCheckout(cartId);
}

async function handleCheckoutSessionCompleted(
  c: Context<HonoEnv>,
  stripe: Stripe,
  webhookSession: Stripe.Checkout.Session,
): Promise<void> {
  if (webhookSession.metadata?.ucp_checkout_session_id) {
    await handleUCPStripeWebhook(c.var.db, c.executionCtx, webhookSession.id, webhookSession);
  }

  const cartId = webhookSession.metadata?.cart_id;
  if (!cartId) return;

  const db = getDb(c.var.db);

  const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
  if (!cart) {
    // A payment for a cart we have no record of cannot become an order —
    // refund it and keep a durable trace.
    await handleOrphanedPayment(c, stripe, webhookSession, cartId, 'cart_not_found');
    return;
  }

  // Retrieve full session from Stripe to get shipping_details
  // (webhook payload sometimes doesn't include all fields)
  const session = await stripe.checkout.sessions.retrieve(webhookSession.id);

  // Extract customer details from full Stripe session
  const customerEmail = cart.customer_email;
  const shippingName = session.shipping_details?.name || session.customer_details?.name || null;
  const shippingPhone = session.shipping_details?.phone || session.customer_details?.phone || null;
  const shippingAddress = session.shipping_details?.address || null;

  // Calculate subtotal from cart items (before discounts)
  const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);
  const subtotalCents = items.reduce(
    (sum: number, item: any) => sum + item.unit_price_cents * item.qty,
    0,
  );

  // Handle discount info from session metadata
  let discountCode: string | null = null;
  let discountId: string | null = null;
  let discountAmountCents = 0;

  if (session.metadata?.discount_id) {
    const [discountRow] = await db.query<any>(`SELECT * FROM discounts WHERE id = ?`, [
      session.metadata.discount_id,
    ]);

    if (discountRow) {
      discountCode = discountRow.code;
      discountId = discountRow.id;
      discountAmountCents = cart.discount_amount_cents || 0;
    }
  }

  // Single atomic RPC: customer upsert, order creation, inventory updates, cart expiry.
  const orderResult = await c.var.db.finalizeOrderFromCart({
    cartId,
    stripeSessionId: session.id,
    stripePaymentIntent: session.payment_intent as string | null,
    customerEmail,
    shippingName,
    shippingPhone,
    shippingAddress: shippingAddress as Record<string, unknown> | null,
    subtotalCents,
    taxCents: session.total_details?.amount_tax ?? 0,
    shippingCents: session.total_details?.amount_shipping ?? 0,
    totalCents: session.amount_total ?? 0,
    currency: cart.currency,
    discountId,
    discountCode,
    discountAmountCents,
  });

  if (!orderResult.ok) {
    // already_finalized: duplicate delivery, the order exists — keep the claim, nothing to do.
    if (orderResult.code === 'already_finalized') return;

    // cart_released / cart_not_found: the customer paid, but the cart's
    // inventory reservation was already released (and possibly resold).
    // Refund instead of creating an empty order. Keep the event claim:
    // a Stripe retry cannot fix this and could double-refund.
    if (orderResult.code === 'cart_released' || orderResult.code === 'cart_not_found') {
      await handleOrphanedPayment(c, stripe, session, cartId, orderResult.code);
      return;
    }

    // Any other domain error is unexpected here — throw so the claim is
    // released and Stripe's retry reprocesses the event.
    throw new Error(
      `finalizeOrderFromCart failed for cart ${cartId}: ${orderResult.code} — ${orderResult.message}`,
    );
  }

  // Dispatch order.created webhook
  const orderItems = await db.query<any>(`SELECT * FROM order_items WHERE order_id = ?`, [
    orderResult.orderId,
  ]);
  await dispatchWebhooks(c.var.db, c.executionCtx, 'order.created', {
    order: {
      id: orderResult.orderId,
      number: orderResult.orderNumber,
      status: 'paid',
      customer_email: customerEmail,
      customer_id: orderResult.customerId,
      shipping: {
        name: shippingName,
        phone: shippingPhone,
        address: shippingAddress,
      },
      amounts: {
        subtotal_cents: session.amount_subtotal ?? 0,
        tax_cents: session.total_details?.amount_tax ?? 0,
        shipping_cents: session.total_details?.amount_shipping ?? 0,
        total_cents: session.amount_total ?? 0,
        currency: cart.currency,
      },
      items: orderItems.map((i: any) => ({
        sku: i.sku,
        title: i.title,
        qty: i.qty,
        unit_price_cents: i.unit_price_cents,
      })),
      stripe: {
        checkout_session_id: session.id,
        payment_intent_id: session.payment_intent,
      },
    },
  });
}

/**
 * A checkout.session.completed arrived for a cart that can no longer become
 * an order (reservation released, items deleted, possibly resold — or no
 * cart row at all). The customer was charged: attempt an automatic refund,
 * record the outcome durably in payment_anomalies, and alert the merchant
 * via an order.failed webhook.
 *
 * Never throws: the event claim must be kept either way, because a Stripe
 * retry cannot repair this state and a second pass could double-refund.
 */
async function handleOrphanedPayment(
  c: Context<HonoEnv>,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  cartId: string,
  reason: 'cart_released' | 'cart_not_found',
): Promise<void> {
  const paymentIntent =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);

  console.error(
    `Orphaned payment: checkout.session.completed for cart ${cartId} (${reason}); ` +
      `session ${session.id}, payment_intent ${paymentIntent} — attempting refund`,
  );

  try {
    let refundId: string | null = null;
    let refundStatus: 'refunded' | 'refund_failed' | 'no_payment_intent';

    if (paymentIntent) {
      try {
        const refund = await stripe.refunds.create({ payment_intent: paymentIntent });
        refundId = refund.id;
        refundStatus = 'refunded';
      } catch (err: any) {
        refundStatus = 'refund_failed';
        console.error(
          `Refund FAILED for orphaned payment ${paymentIntent} (session ${session.id}): ${err.message}. ` +
            `Manual refund required.`,
        );
      }
    } else {
      refundStatus = 'no_payment_intent';
      console.error(
        `Orphaned payment for session ${session.id} has no payment_intent — cannot auto-refund.`,
      );
    }

    const customerEmail = session.customer_details?.email ?? session.customer_email ?? null;
    const amountCents = session.amount_total ?? 0;
    const currency = (session.currency ?? 'usd').toUpperCase();

    await c.var.db.recordPaymentAnomaly({
      type: 'orphaned_payment',
      cartId,
      stripeSessionId: session.id,
      stripePaymentIntentId: paymentIntent,
      amountCents,
      currency,
      customerEmail,
      refundId,
      refundStatus,
      message: `checkout.session.completed for a released cart (${reason})`,
    });

    await dispatchWebhooks(c.var.db, c.executionCtx, 'order.failed', {
      reason,
      cart_id: cartId,
      customer_email: customerEmail,
      amounts: { total_cents: amountCents, currency },
      refund: { id: refundId, status: refundStatus },
      stripe: {
        checkout_session_id: session.id,
        payment_intent_id: paymentIntent,
      },
    });
  } catch (err: any) {
    // Recording/alerting failed. The console.error trail above is all that's
    // left; still swallow the error so the claim is kept (see docstring).
    console.error(
      `Failed to record orphaned payment for session ${session.id}: ${err?.message ?? err}`,
    );
  }
}
