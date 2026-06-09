import { Hono } from 'hono';
import Stripe from 'stripe';
import { getDb } from '../db';
import { dispatchWebhooks } from '../lib/webhooks';
import { ApiError, type HonoEnv, uuid } from '../types';
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

  // Get stripe keys from config
  const [config] = await db.query<any>(`SELECT * FROM config WHERE key = 'stripe'`);
  if (!config?.value) {
    throw ApiError.invalidRequest('Stripe not configured');
  }

  const stripeConfig = JSON.parse(config.value);
  if (!stripeConfig.webhook_secret) {
    throw ApiError.invalidRequest('Stripe webhook secret not configured');
  }

  // Verify signature
  const stripe = new Stripe(stripeConfig.secret_key);
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, stripeConfig.webhook_secret);
  } catch (e: any) {
    throw new ApiError('webhook_signature_invalid', 400, e.message);
  }

  // Dedupe
  const [existing] = await db.query<any>(`SELECT id FROM events WHERE stripe_event_id = ?`, [
    event.id,
  ]);
  if (existing) return c.json({ ok: true });

  if (event.type === 'checkout.session.completed') {
    const webhookSession = event.data.object as Stripe.Checkout.Session;

    if (webhookSession.metadata?.ucp_checkout_session_id) {
      await handleUCPStripeWebhook(db, webhookSession.id, webhookSession);
    }

    const cartId = webhookSession.metadata?.cart_id;

    if (cartId) {
      const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
      if (cart) {
        // Retrieve full session from Stripe to get shipping_details
        // (webhook payload sometimes doesn't include all fields)
        const session = await stripe.checkout.sessions.retrieve(webhookSession.id);

        // Extract customer details from full Stripe session
        const customerEmail = cart.customer_email;
        const shippingName =
          session.shipping_details?.name || session.customer_details?.name || null;
        const shippingPhone =
          session.shipping_details?.phone || session.customer_details?.phone || null;
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

        // Single atomic RPC: customer upsert, order creation, inventory updates, cart expiry
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

        if (orderResult.ok) {
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
      }
    }
  }

  // Log event
  await db.run(`INSERT INTO events (id, stripe_event_id, type, payload) VALUES (?, ?, ?, ?)`, [
    uuid(),
    event.id,
    event.type,
    JSON.stringify(event.data.object),
  ]);

  return c.json({ ok: true });
});
