import { DurableObject } from 'cloudflare:workers';
import { calculateDiscount, type Discount, validateDiscountFields } from './lib/discounts';
import { applyMigrations, MIGRATIONS } from './migrations';
import type { Env } from './types';
import { generateOrderNumber, now, uuid } from './types';

/**
 * The Durable Object environment type is identical to the Worker Env.
 * Re-exported here so that existing imports of `MerchantEnv` continue to work.
 */
export type MerchantEnv = Env;

// ─── Data retention constants ────────────────────────────────────────────────

/** How many days to keep analytics_events and analytics_sessions rows. */
const ANALYTICS_RETENTION_DAYS = 90;

/**
 * How many days to keep rows in the `events` table (Stripe webhook idempotency
 * store). Stripe retries webhooks for at most ~3 days, so 30 days is safe.
 */
const EVENTS_RETENTION_DAYS = 30;

/** How many days to keep webhook_deliveries rows. */
const DELIVERIES_RETENTION_DAYS = 30;

/** How many hours to keep idempotency_keys rows (Stripe-style 24-hour window). */
const IDEMPOTENCY_RETENTION_HOURS = 24;

export type WSEventType =
  | 'cart.updated'
  | 'cart.checked_out'
  | 'order.created'
  | 'order.updated'
  | 'order.shipped'
  | 'order.refunded'
  | 'inventory.updated'
  | 'inventory.low'
  | 'presence.count';

export interface WSEvent {
  type: WSEventType;
  data: unknown;
  timestamp: string;
}

// ─── Result types for domain methods ────────────────────────────────────────

export type DomainError =
  | { ok: false; code: 'cart_not_found'; message: string }
  | { ok: false; code: 'cart_not_open'; message: string }
  | { ok: false; code: 'sku_not_found'; message: string; details: { sku: string } }
  | { ok: false; code: 'sku_not_active'; message: string; details: { sku: string } }
  | { ok: false; code: 'insufficient_inventory'; message: string; details: { sku: string } }
  | { ok: false; code: 'discount_invalid'; message: string }
  | { ok: false; code: 'product_not_found'; message: string }
  | { ok: false; code: 'product_has_orders'; message: string }
  | { ok: false; code: 'cart_empty'; message: string }
  | { ok: false; code: 'already_finalized'; message: string; orderId: string };

export interface ClaimEventResult {
  claimed: boolean;
}

export interface CartItemPayload {
  sku: string;
  title: string;
  qty: number;
  unit_price_cents: number;
}

export interface CartDiscountInfo {
  code: string;
  type: 'percentage' | 'fixed_amount';
  amount_cents: number;
}

export interface CartTotalsPayload {
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
}

export interface CartPayload {
  id: string;
  status: string;
  currency: string;
  customer_email: string;
  items: CartItemPayload[];
  discount: CartDiscountInfo | null;
  totals: CartTotalsPayload;
  expires_at: string;
}

export interface CheckoutReadyPayload {
  cart: {
    id: string;
    customer_email: string;
    currency: string;
    discount_id: string | null;
    discount_amount_cents: number;
    expires_at: string;
  };
  items: CartItemPayload[];
  discount: (Discount & { amount_cents: number }) | null;
  subtotal_cents: number;
}

export interface FinalizeOrderArgs {
  cartId: string;
  stripeSessionId: string;
  stripePaymentIntent: string | null;
  customerEmail: string;
  shippingName: string | null;
  shippingPhone: string | null;
  shippingAddress: Record<string, unknown> | null;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  currency: string;
  discountId: string | null;
  discountCode: string | null;
  discountAmountCents: number;
}

export interface OrderItemPayload {
  sku: string;
  title: string;
  qty: number;
  unit_price_cents: number;
}

export interface FinalizeOrderResult {
  ok: true;
  orderId: string;
  orderNumber: string;
  customerId: string;
  items: OrderItemPayload[];
  skuAvailability: Array<{ sku: string; available: number }>;
}

export type ReleaseAbandonedCheckoutResult =
  | { released: true; skuAvailability: Array<{ sku: string; available: number }> }
  | { released: false; reason: 'not_found' | 'wrong_status' };

// ─── UCP Finalize Order ─────────────────────────────────────────────────────

export interface UCPFinalizeOrderArgs {
  ucpSessionId: string;
  stripeSessionId: string;
  stripePaymentIntent: string | null;
}

export interface UCPFinalizeOrderResult {
  ok: true;
  orderId: string;
  orderNumber: string;
  customerEmail: string;
  currency: string;
  items: OrderItemPayload[];
  oversold: boolean;
}

export interface TestOrderArgs {
  customerEmail: string;
  items: Array<{ sku: string; qty: number }>;
  discountCode?: string | null;
}

export interface TestOrderResult {
  ok: true;
  order: {
    id: string;
    number: string;
    status: string;
    customer_email: string;
    customer_id: string | null;
    subtotal_cents: number;
    discount_amount_cents: number;
    tax_cents: number;
    shipping_cents: number;
    total_cents: number;
    discount_code: string | null;
    discount_id: string | null;
    currency: string;
    created_at: string;
    // Fields present on DB rows but not applicable to test orders
    shipping_name: null;
    shipping_phone: null;
    ship_to: null;
    tracking_number: null;
    tracking_url: null;
    shipped_at: null;
    stripe_checkout_session_id: null;
    stripe_payment_intent_id: null;
  };
  items: OrderItemPayload[];
}

export class MerchantDO extends DurableObject<MerchantEnv> {
  private sql: SqlStorage;
  private sessions: Map<WebSocket, { topics: Set<string>; role: 'admin' | 'public' | 'anon' }> =
    new Map();
  private initialized = false;

  constructor(ctx: DurableObjectState, env: MerchantEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    applyMigrations(this.ctx.storage, MIGRATIONS);
    this.initialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureInitialized();

    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      return await this.handleWebSocketUpgrade(request);
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, storage: 'sqlite' });
    }

    return new Response('Not found', { status: 404 });
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    this.ensureInitialized();
    const cursor = this.sql.exec(sql, ...params);
    return cursor.toArray() as T[];
  }

  run(sql: string, params: unknown[] = []): { changes: number } {
    this.ensureInitialized();
    this.sql.exec(sql, ...params);
    const [result] = this.sql.exec('SELECT changes() as changes').toArray() as [
      { changes: number },
    ];
    return { changes: result.changes };
  }

  // ─── Internal sync helpers ──────────────────────────────────────────────────

  private sqlQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const cursor = this.sql.exec(sql, ...params);
    return cursor.toArray() as T[];
  }

  private sqlRun(sql: string, params: unknown[] = []): { changes: number } {
    this.sql.exec(sql, ...params);
    const [result] = this.sql.exec('SELECT changes() as changes').toArray() as [
      { changes: number },
    ];
    return { changes: result.changes };
  }

  /** Build the full cart payload synchronously from existing state. */
  private buildCartPayload(
    cart: Record<string, unknown>,
    items: Array<Record<string, unknown>>,
    expiresAt?: string,
  ): CartPayload {
    const subtotalCents = items.reduce(
      (sum, item) => sum + (item.unit_price_cents as number) * (item.qty as number),
      0,
    );

    let discountInfo: CartDiscountInfo | null = null;
    let discountAmountCents = 0;

    if (cart.discount_id) {
      const [discount] = this.sqlQuery<Record<string, unknown>>(
        `SELECT * FROM discounts WHERE id = ?`,
        [cart.discount_id as string],
      );
      if (discount) {
        try {
          validateDiscountFields(discount as unknown as Discount, subtotalCents);
          // Also check per-customer usage synchronously
          if (
            cart.customer_email &&
            (discount.usage_limit_per_customer as number | null) !== null
          ) {
            const [usage] = this.sqlQuery<{ count: number }>(
              `SELECT COUNT(*) as count FROM discount_usage WHERE discount_id = ? AND customer_email = ?`,
              [discount.id as string, (cart.customer_email as string).toLowerCase()],
            );
            if (usage && usage.count >= (discount.usage_limit_per_customer as number)) {
              // Discount no longer valid for this customer — clear it
              this.sqlRun(
                `UPDATE carts SET discount_code = NULL, discount_id = NULL, discount_amount_cents = 0 WHERE id = ?`,
                [cart.id as string],
              );
              discountInfo = null;
              discountAmountCents = 0;
              return this._buildCartResponse(cart, items, expiresAt, null, 0, subtotalCents);
            }
          }
          discountAmountCents = calculateDiscount(discount as unknown as Discount, subtotalCents);
          this.sqlRun(`UPDATE carts SET discount_amount_cents = ? WHERE id = ?`, [
            discountAmountCents,
            cart.id as string,
          ]);
          discountInfo = {
            code: discount.code as string,
            type: discount.type as 'percentage' | 'fixed_amount',
            amount_cents: discountAmountCents,
          };
        } catch {
          // Discount no longer valid — clear it from cart
          this.sqlRun(
            `UPDATE carts SET discount_code = NULL, discount_id = NULL, discount_amount_cents = 0 WHERE id = ?`,
            [cart.id as string],
          );
          discountInfo = null;
          discountAmountCents = 0;
        }
      } else {
        this.sqlRun(
          `UPDATE carts SET discount_code = NULL, discount_id = NULL, discount_amount_cents = 0 WHERE id = ?`,
          [cart.id as string],
        );
      }
    }

    return this._buildCartResponse(
      cart,
      items,
      expiresAt,
      discountInfo,
      discountAmountCents,
      subtotalCents,
    );
  }

  private _buildCartResponse(
    cart: Record<string, unknown>,
    items: Array<Record<string, unknown>>,
    expiresAt: string | undefined,
    discountInfo: CartDiscountInfo | null,
    discountAmountCents: number,
    subtotalCents: number,
  ): CartPayload {
    return {
      id: cart.id as string,
      status: cart.status as string,
      currency: cart.currency as string,
      customer_email: cart.customer_email as string,
      items: items.map((item) => ({
        sku: item.sku as string,
        title: item.title as string,
        qty: item.qty as number,
        unit_price_cents: item.unit_price_cents as number,
      })),
      discount: discountInfo,
      totals: {
        subtotal_cents: subtotalCents,
        discount_cents: discountAmountCents,
        shipping_cents: 0,
        tax_cents: 0,
        total_cents: subtotalCents - discountAmountCents,
      },
      expires_at: expiresAt ?? (cart.expires_at as string),
    };
  }

  // ─── Domain Methods ─────────────────────────────────────────────────────────

  /**
   * Replace all items in a cart atomically.
   * Validates cart open, validates variants active, releases old reservations,
   * deletes old items, reserves+inserts new ones, recomputes subtotal,
   * revalidates attached discount.
   * Returns full cart payload so the route makes ZERO further reads.
   */
  cartReplaceItems(
    cartId: string,
    items: Array<{ sku: string; qty: number }>,
  ): CartPayload | DomainError {
    this.ensureInitialized();

    return this.ctx.storage.transactionSync(() => {
      const [cart] = this.sqlQuery<Record<string, unknown>>(`SELECT * FROM carts WHERE id = ?`, [
        cartId,
      ]);
      if (!cart) return { ok: false, code: 'cart_not_found' as const, message: 'Cart not found' };
      if (cart.status !== 'open')
        return { ok: false, code: 'cart_not_open' as const, message: 'Cart is not open' };

      // Validate all variants before any mutations
      const validatedItems: Array<{
        sku: string;
        title: string;
        qty: number;
        unit_price_cents: number;
      }> = [];
      for (const { sku, qty } of items) {
        const [variant] = this.sqlQuery<Record<string, unknown>>(
          `SELECT * FROM variants WHERE sku = ?`,
          [sku],
        );
        if (!variant)
          return {
            ok: false,
            code: 'sku_not_found' as const,
            message: `SKU not found: ${sku}`,
            details: { sku },
          };
        if (variant.status !== 'active')
          return {
            ok: false,
            code: 'sku_not_active' as const,
            message: `SKU not active: ${sku}`,
            details: { sku },
          };
        validatedItems.push({
          sku,
          title: variant.title as string,
          qty,
          unit_price_cents: variant.price_cents as number,
        });
      }

      // Release existing reservations
      const oldItems = this.sqlQuery<{ sku: string; qty: number }>(
        `SELECT sku, qty FROM cart_items WHERE cart_id = ?`,
        [cartId],
      );
      for (const old of oldItems) {
        this.sqlRun(
          `UPDATE inventory SET reserved = MAX(reserved - ?, 0), updated_at = ? WHERE sku = ?`,
          [old.qty, now(), old.sku],
        );
      }

      this.sqlRun(`DELETE FROM cart_items WHERE cart_id = ?`, [cartId]);

      // Reserve + insert new items; if any reservation fails, release all
      // already-reserved items in this same transaction (net-zero inventory change)
      const reservedSkus: Array<{ sku: string; qty: number }> = [];
      let insufficientSku: string | null = null;

      for (const item of validatedItems) {
        const result = this.sqlRun(
          `UPDATE inventory SET reserved = reserved + ?, updated_at = ? WHERE sku = ? AND on_hand - reserved >= ?`,
          [item.qty, now(), item.sku, item.qty],
        );
        if (result.changes === 0) {
          insufficientSku = item.sku;
          break;
        }
        reservedSkus.push({ sku: item.sku, qty: item.qty });
        this.sqlRun(
          `INSERT INTO cart_items (id, cart_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`,
          [uuid(), cartId, item.sku, item.title, item.qty, item.unit_price_cents],
        );
      }

      if (insufficientSku !== null) {
        // Release all reservations made so far and clear inserted cart items
        for (const r of reservedSkus) {
          this.sqlRun(
            `UPDATE inventory SET reserved = MAX(reserved - ?, 0), updated_at = ? WHERE sku = ?`,
            [r.qty, now(), r.sku],
          );
        }
        this.sqlRun(`DELETE FROM cart_items WHERE cart_id = ?`, [cartId]);
        return {
          ok: false,
          code: 'insufficient_inventory' as const,
          message: `Insufficient inventory for SKU: ${insufficientSku}`,
          details: { sku: insufficientSku },
        };
      }

      const allItems = this.sqlQuery<Record<string, unknown>>(
        `SELECT * FROM cart_items WHERE cart_id = ?`,
        [cartId],
      );

      return this.buildCartPayload(cart, allItems);
    }) as CartPayload | DomainError;
  }

  /**
   * Incremental add/remove of a single SKU with atomic inventory reservation.
   * Positive qty adds (reserves), negative qty removes (releases).
   * Also bumps expires_at by 30 minutes.
   */
  cartAddItem(cartId: string, sku: string, qty: number): CartPayload | DomainError {
    this.ensureInitialized();

    return this.ctx.storage.transactionSync(() => {
      const [cart] = this.sqlQuery<Record<string, unknown>>(`SELECT * FROM carts WHERE id = ?`, [
        cartId,
      ]);
      if (!cart) return { ok: false, code: 'cart_not_found' as const, message: 'Cart not found' };
      if (cart.status !== 'open')
        return { ok: false, code: 'cart_not_open' as const, message: 'Cart is not open' };

      const [variant] = this.sqlQuery<Record<string, unknown>>(
        `SELECT * FROM variants WHERE sku = ?`,
        [sku],
      );
      if (!variant)
        return {
          ok: false,
          code: 'sku_not_found' as const,
          message: `SKU not found: ${sku}`,
          details: { sku },
        };
      if (variant.status !== 'active')
        return {
          ok: false,
          code: 'sku_not_active' as const,
          message: `SKU not active: ${sku}`,
          details: { sku },
        };

      const [existingItem] = this.sqlQuery<{ id: string; qty: number }>(
        `SELECT id, qty FROM cart_items WHERE cart_id = ? AND sku = ?`,
        [cartId, sku],
      );
      const currentQty = existingItem?.qty ?? 0;

      if (qty > 0) {
        const result = this.sqlRun(
          `UPDATE inventory SET reserved = reserved + ?, updated_at = ? WHERE sku = ? AND on_hand - reserved >= ?`,
          [qty, now(), sku, qty],
        );
        if (result.changes === 0) {
          return {
            ok: false,
            code: 'insufficient_inventory' as const,
            message: `Insufficient inventory for SKU: ${sku}`,
            details: { sku },
          };
        }

        if (existingItem) {
          this.sqlRun(`UPDATE cart_items SET qty = qty + ? WHERE cart_id = ? AND sku = ?`, [
            qty,
            cartId,
            sku,
          ]);
        } else {
          this.sqlRun(
            `INSERT INTO cart_items (id, cart_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`,
            [uuid(), cartId, sku, variant.title as string, qty, variant.price_cents as number],
          );
        }
      } else {
        const release = Math.min(Math.abs(qty), currentQty);
        if (release > 0) {
          this.sqlRun(
            `UPDATE inventory SET reserved = MAX(reserved - ?, 0), updated_at = ? WHERE sku = ?`,
            [release, now(), sku],
          );
          const newQty = currentQty - release;
          if (newQty <= 0) {
            this.sqlRun(`DELETE FROM cart_items WHERE cart_id = ? AND sku = ?`, [cartId, sku]);
          } else {
            this.sqlRun(`UPDATE cart_items SET qty = ? WHERE cart_id = ? AND sku = ?`, [
              newQty,
              cartId,
              sku,
            ]);
          }
        }
      }

      const newExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      this.sqlRun(`UPDATE carts SET expires_at = ?, updated_at = ? WHERE id = ?`, [
        newExpiresAt,
        now(),
        cartId,
      ]);

      const allItems = this.sqlQuery<Record<string, unknown>>(
        `SELECT * FROM cart_items WHERE cart_id = ?`,
        [cartId],
      );

      return this.buildCartPayload(cart, allItems, newExpiresAt);
    }) as CartPayload | DomainError;
  }

  /**
   * Atomically flip cart open→checked_out, load cart+items, verify inventory
   * still consistent, validate+reserve discount usage.
   * Returns everything the route needs for Stripe session creation.
   */
  cartBeginCheckout(cartId: string): CheckoutReadyPayload | DomainError {
    this.ensureInitialized();

    return this.ctx.storage.transactionSync(() => {
      // Atomically flip status open→checked_out
      const flipResult = this.sqlRun(
        `UPDATE carts SET status = 'checked_out', updated_at = ? WHERE id = ? AND status = 'open'`,
        [now(), cartId],
      );

      if (flipResult.changes === 0) {
        const [cart] = this.sqlQuery<Record<string, unknown>>(`SELECT * FROM carts WHERE id = ?`, [
          cartId,
        ]);
        if (!cart) return { ok: false, code: 'cart_not_found' as const, message: 'Cart not found' };
        return { ok: false, code: 'cart_not_open' as const, message: 'Cart is not open' };
      }

      const [cart] = this.sqlQuery<Record<string, unknown>>(`SELECT * FROM carts WHERE id = ?`, [
        cartId,
      ]);
      if (!cart) return { ok: false, code: 'cart_not_found' as const, message: 'Cart not found' };

      const items = this.sqlQuery<Record<string, unknown>>(
        `SELECT * FROM cart_items WHERE cart_id = ?`,
        [cartId],
      );

      if (items.length === 0) {
        // Revert status
        this.sqlRun(`UPDATE carts SET status = 'open', updated_at = ? WHERE id = ?`, [
          now(),
          cartId,
        ]);
        return { ok: false, code: 'cart_empty' as const, message: 'Cart is empty' };
      }

      const subtotalCents = items.reduce(
        (sum, item) => sum + (item.unit_price_cents as number) * (item.qty as number),
        0,
      );

      // Verify inventory is still sufficient
      for (const item of items) {
        const [inv] = this.sqlQuery<{ on_hand: number; reserved: number }>(
          `SELECT on_hand, reserved FROM inventory WHERE sku = ?`,
          [item.sku as string],
        );
        if (!inv || inv.on_hand < (item.qty as number)) {
          this.sqlRun(`UPDATE carts SET status = 'open', updated_at = ? WHERE id = ?`, [
            now(),
            cartId,
          ]);
          return {
            ok: false,
            code: 'insufficient_inventory' as const,
            message: `Insufficient inventory for SKU: ${item.sku as string}`,
            details: { sku: item.sku as string },
          };
        }
      }

      // Validate and reserve discount usage
      let discountObj: (Discount & { amount_cents: number }) | null = null;
      let finalDiscountAmountCents = (cart.discount_amount_cents as number) ?? 0;

      if (cart.discount_id) {
        const [discountRow] = this.sqlQuery<Record<string, unknown>>(
          `SELECT * FROM discounts WHERE id = ?`,
          [cart.discount_id as string],
        );

        if (discountRow) {
          const discount = discountRow as unknown as Discount;

          try {
            validateDiscountFields(discount, subtotalCents);
          } catch (err) {
            // Discount no longer valid — clear and revert
            this.sqlRun(
              `UPDATE carts SET discount_code = NULL, discount_id = NULL, discount_amount_cents = 0, status = 'open', updated_at = ? WHERE id = ?`,
              [now(), cartId],
            );
            if (err instanceof Error) {
              return {
                ok: false,
                code: 'discount_invalid' as const,
                message: err.message,
              };
            }
            return {
              ok: false,
              code: 'discount_invalid' as const,
              message: 'Discount is no longer valid',
            };
          }

          // Check per-customer usage
          if (discount.usage_limit_per_customer !== null) {
            const [usage] = this.sqlQuery<{ count: number }>(
              `SELECT COUNT(*) as count FROM discount_usage WHERE discount_id = ? AND customer_email = ?`,
              [discount.id, (cart.customer_email as string).toLowerCase()],
            );
            if (usage && usage.count >= discount.usage_limit_per_customer) {
              this.sqlRun(
                `UPDATE carts SET discount_code = NULL, discount_id = NULL, discount_amount_cents = 0, status = 'open', updated_at = ? WHERE id = ?`,
                [now(), cartId],
              );
              return {
                ok: false,
                code: 'discount_invalid' as const,
                message: 'You have already used this discount',
              };
            }
          }

          const currentTime = now();

          if (discount.usage_limit !== null) {
            const result = this.sqlRun(
              `UPDATE discounts
               SET usage_count = usage_count + 1, updated_at = ?
               WHERE id = ?
                 AND status = 'active'
                 AND (starts_at IS NULL OR starts_at <= ?)
                 AND (expires_at IS NULL OR expires_at >= ?)
                 AND usage_count < usage_limit`,
              [currentTime, discount.id, currentTime, currentTime],
            );

            if (result.changes === 0) {
              this.sqlRun(
                `UPDATE carts SET discount_code = NULL, discount_id = NULL, discount_amount_cents = 0, status = 'open', updated_at = ? WHERE id = ?`,
                [now(), cartId],
              );
              return {
                ok: false,
                code: 'discount_invalid' as const,
                message: 'Discount usage limit reached',
              };
            }
          } else {
            const result = this.sqlRun(
              `UPDATE discounts
               SET updated_at = ?
               WHERE id = ?
                 AND status = 'active'
                 AND (starts_at IS NULL OR starts_at <= ?)
                 AND (expires_at IS NULL OR expires_at >= ?)`,
              [currentTime, discount.id, currentTime, currentTime],
            );

            if (result.changes === 0) {
              this.sqlRun(
                `UPDATE carts SET discount_code = NULL, discount_id = NULL, discount_amount_cents = 0, status = 'open', updated_at = ? WHERE id = ?`,
                [now(), cartId],
              );
              return {
                ok: false,
                code: 'discount_invalid' as const,
                message: 'Discount is no longer valid',
              };
            }
          }

          finalDiscountAmountCents = calculateDiscount(discount, subtotalCents);
          discountObj = { ...discount, amount_cents: finalDiscountAmountCents };
        } else {
          this.sqlRun(
            `UPDATE carts SET discount_code = NULL, discount_id = NULL, discount_amount_cents = 0 WHERE id = ?`,
            [cartId],
          );
        }
      }

      return {
        cart: {
          id: cart.id as string,
          customer_email: cart.customer_email as string,
          currency: cart.currency as string,
          discount_id: cart.discount_id as string | null,
          discount_amount_cents: finalDiscountAmountCents,
          expires_at: cart.expires_at as string,
        },
        items: items.map((item) => ({
          sku: item.sku as string,
          title: item.title as string,
          qty: item.qty as number,
          unit_price_cents: item.unit_price_cents as number,
        })),
        discount: discountObj,
        subtotal_cents: subtotalCents,
      };
    }) as CheckoutReadyPayload | DomainError;
  }

  /**
   * Revert a cart from checked_out back to open.
   * Optionally decrements discount usage_count if it was reserved.
   */
  cartRevertCheckout(cartId: string, releaseDiscountId?: string): void {
    this.ensureInitialized();

    this.ctx.storage.transactionSync(() => {
      this.sqlRun(`UPDATE carts SET status = 'open', updated_at = ? WHERE id = ?`, [now(), cartId]);
      if (releaseDiscountId) {
        this.sqlRun(
          `UPDATE discounts SET usage_count = MAX(usage_count - 1, 0), updated_at = ? WHERE id = ?`,
          [now(), releaseDiscountId],
        );
      }
    });
  }

  /**
   * Release inventory reservations and discount usage for an abandoned checkout.
   *
   * Idempotent: if the cart doesn't exist or is not in 'checked_out' status
   * (e.g. it was already finalized into an order, which sets status='expired',
   * or already released by a prior call), this is a no-op.
   *
   * Only decrements discount usage_count if the discount has a usage_limit
   * (mirrors the reservation logic in cartBeginCheckout).
   *
   * Broadcasts inventory.updated after commit.
   */
  releaseAbandonedCheckout(cartId: string): ReleaseAbandonedCheckoutResult {
    this.ensureInitialized();

    const skuAvailability: Array<{ sku: string; available: number }> = [];

    const released = this.ctx.storage.transactionSync(() => {
      const [cart] = this.sqlQuery<Record<string, unknown>>(`SELECT * FROM carts WHERE id = ?`, [
        cartId,
      ]);
      if (!cart) return false;
      if (cart.status !== 'checked_out') return false;

      const items = this.sqlQuery<{ sku: string; qty: number }>(
        `SELECT sku, qty FROM cart_items WHERE cart_id = ?`,
        [cartId],
      );

      // Release inventory reservations
      for (const item of items) {
        this.sqlRun(
          `UPDATE inventory SET reserved = MAX(reserved - ?, 0), updated_at = ? WHERE sku = ?`,
          [item.qty, now(), item.sku],
        );
      }

      // Decrement usage_count only for usage-limited discounts
      if (cart.discount_id) {
        const [discountRow] = this.sqlQuery<{ usage_limit: number | null }>(
          `SELECT usage_limit FROM discounts WHERE id = ?`,
          [cart.discount_id as string],
        );
        if (discountRow?.usage_limit !== null) {
          this.sqlRun(
            `UPDATE discounts SET usage_count = MAX(usage_count - 1, 0), updated_at = ? WHERE id = ?`,
            [now(), cart.discount_id as string],
          );
        }
      }

      // Mark cart expired and remove items (consistent with cleanupExpiredCarts)
      this.sqlRun(`UPDATE carts SET status = 'expired', updated_at = ? WHERE id = ?`, [
        now(),
        cartId,
      ]);
      this.sqlRun(`DELETE FROM cart_items WHERE cart_id = ?`, [cartId]);

      // Collect availability after updates for broadcast
      for (const item of items) {
        const [inv] = this.sqlQuery<{ on_hand: number; reserved: number }>(
          `SELECT on_hand, reserved FROM inventory WHERE sku = ?`,
          [item.sku],
        );
        skuAvailability.push({
          sku: item.sku,
          available: inv ? Math.max(0, inv.on_hand - inv.reserved) : 0,
        });
      }

      return true;
    }) as boolean;

    if (!released) {
      const [cart] = this.sqlQuery<{ status: string }>(`SELECT status FROM carts WHERE id = ?`, [
        cartId,
      ]);
      return { released: false, reason: cart ? 'wrong_status' : 'not_found' };
    }

    // Broadcast inventory updates after commit
    for (const { sku, available } of skuAvailability) {
      this.broadcast({
        type: 'inventory.updated',
        data: { sku, available },
        timestamp: new Date().toISOString(),
      });
    }

    return { released: true, skuAvailability };
  }

  /**
   * Finalize order from a completed Stripe checkout session.
   * Everything from customer upsert through order insert, order_items,
   * discount_usage recording, inventory decrement + logs, cart status flip.
   * Broadcasts inventory.updated after commit.
   */
  finalizeOrderFromCart(args: FinalizeOrderArgs): FinalizeOrderResult | DomainError {
    this.ensureInitialized();

    const {
      cartId,
      stripeSessionId,
      stripePaymentIntent,
      customerEmail,
      shippingName,
      shippingPhone,
      shippingAddress,
      subtotalCents,
      taxCents,
      shippingCents,
      totalCents,
      currency,
      discountId,
      discountCode,
      discountAmountCents,
    } = args;

    const skuAvailability: Array<{ sku: string; available: number }> = [];
    let orderId = '';
    let orderNumber = '';
    let customerId = '';
    let orderItemsResult: OrderItemPayload[] = [];
    let alreadyFinalizedOrderId: string | null = null;

    this.ctx.storage.transactionSync(() => {
      // Belt-and-braces: if an order for this Stripe session already exists, skip creation.
      const [existingOrder] = this.sqlQuery<{ id: string }>(
        `SELECT id FROM orders WHERE stripe_checkout_session_id = ?`,
        [stripeSessionId],
      );
      if (existingOrder) {
        alreadyFinalizedOrderId = existingOrder.id;
        return;
      }

      const [cart] = this.sqlQuery<Record<string, unknown>>(`SELECT * FROM carts WHERE id = ?`, [
        cartId,
      ]);
      if (!cart) return;

      const items = this.sqlQuery<{
        sku: string;
        title: string;
        qty: number;
        unit_price_cents: number;
      }>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);

      // Upsert customer
      const [existingCustomer] = this.sqlQuery<{
        id: string;
        order_count: number;
        total_spent_cents: number;
      }>(`SELECT id, order_count, total_spent_cents FROM customers WHERE email = ?`, [
        customerEmail,
      ]);

      const timestamp = now();

      if (existingCustomer) {
        customerId = existingCustomer.id;
        this.sqlRun(
          `UPDATE customers SET
            name = COALESCE(?, name),
            phone = COALESCE(?, phone),
            order_count = order_count + 1,
            total_spent_cents = total_spent_cents + ?,
            last_order_at = ?,
            updated_at = ?
          WHERE id = ?`,
          [shippingName, shippingPhone, totalCents, timestamp, timestamp, customerId],
        );
      } else {
        customerId = uuid();
        this.sqlRun(
          `INSERT INTO customers (id, email, name, phone, order_count, total_spent_cents, last_order_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
          [customerId, customerEmail, shippingName, shippingPhone, totalCents, timestamp],
        );
      }

      // Save shipping address if provided
      if (shippingAddress && customerId) {
        const [existingAddress] = this.sqlQuery<{ id: string }>(
          `SELECT id FROM customer_addresses WHERE customer_id = ? AND line1 = ? AND postal_code = ?`,
          [customerId, shippingAddress.line1 as string, shippingAddress.postal_code as string],
        );

        if (!existingAddress) {
          const [addressCount] = this.sqlQuery<{ count: number }>(
            `SELECT COUNT(*) as count FROM customer_addresses WHERE customer_id = ?`,
            [customerId],
          );
          const isDefault = addressCount.count === 0 ? 1 : 0;

          this.sqlRun(
            `INSERT INTO customer_addresses (id, customer_id, is_default, name, line1, line2, city, state, postal_code, country, phone)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              uuid(),
              customerId,
              isDefault,
              shippingName,
              shippingAddress.line1 as string,
              (shippingAddress.line2 as string) || null,
              shippingAddress.city as string,
              shippingAddress.state as string,
              shippingAddress.postal_code as string,
              shippingAddress.country as string,
              shippingPhone,
            ],
          );
        }
      }

      // Create order
      orderId = uuid();
      orderNumber = generateOrderNumber();

      this.sqlRun(
        `INSERT INTO orders (id, customer_id, number, status, customer_email,
         shipping_name, shipping_phone, ship_to,
         subtotal_cents, tax_cents, shipping_cents, total_cents, currency,
         discount_code, discount_id, discount_amount_cents,
         stripe_checkout_session_id, stripe_payment_intent_id)
         VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          customerId,
          orderNumber,
          customerEmail,
          shippingName,
          shippingPhone,
          shippingAddress ? JSON.stringify(shippingAddress) : null,
          subtotalCents,
          taxCents,
          shippingCents,
          totalCents,
          currency,
          discountCode,
          discountId,
          discountAmountCents,
          stripeSessionId,
          stripePaymentIntent,
        ],
      );

      // Track discount usage
      if (discountId && discountAmountCents > 0) {
        const [existingUsage] = this.sqlQuery<{ id: string }>(
          `SELECT id FROM discount_usage WHERE order_id = ? AND discount_id = ?`,
          [orderId, discountId],
        );

        if (!existingUsage) {
          const [discountRow] = this.sqlQuery<{ usage_limit_per_customer: number | null }>(
            `SELECT usage_limit_per_customer FROM discounts WHERE id = ?`,
            [discountId],
          );

          if (discountRow?.usage_limit_per_customer !== null) {
            const usageId = uuid();
            const customerEmailLower = customerEmail.toLowerCase();
            const result = this.sqlRun(
              `INSERT INTO discount_usage (id, discount_id, order_id, customer_email, discount_amount_cents)
               SELECT ?, ?, ?, ?, ?
               WHERE (
                 SELECT COUNT(*) FROM discount_usage
                 WHERE discount_id = ? AND customer_email = ?
               ) < ?`,
              [
                usageId,
                discountId,
                orderId,
                customerEmailLower,
                discountAmountCents,
                discountId,
                customerEmailLower,
                discountRow.usage_limit_per_customer,
              ],
            );

            if (result.changes === 0) {
              console.warn(
                `Discount usage limit exceeded for customer ${customerEmailLower} and discount ${discountId}, ` +
                  `but order ${orderId} already created (payment succeeded).`,
              );
            }
          } else {
            this.sqlRun(
              `INSERT INTO discount_usage (id, discount_id, order_id, customer_email, discount_amount_cents)
               VALUES (?, ?, ?, ?, ?)`,
              [uuid(), discountId, orderId, customerEmail.toLowerCase(), discountAmountCents],
            );
          }
        }
      }

      // Create order items, decrement inventory
      orderItemsResult = items;
      for (const item of items) {
        this.sqlRun(
          `INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`,
          [uuid(), orderId, item.sku, item.title, item.qty, item.unit_price_cents],
        );

        this.sqlRun(
          `UPDATE inventory SET reserved = MAX(reserved - ?, 0), on_hand = on_hand - ?, updated_at = ? WHERE sku = ?`,
          [item.qty, item.qty, now(), item.sku],
        );

        this.sqlRun(
          `INSERT INTO inventory_logs (id, sku, delta, reason) VALUES (?, ?, ?, 'sale')`,
          [uuid(), item.sku, -item.qty],
        );
      }

      // Flip cart to expired
      this.sqlRun(`UPDATE carts SET status = 'expired', updated_at = ? WHERE id = ?`, [
        now(),
        cartId,
      ]);

      // Collect availability for broadcast (after inventory updates)
      for (const item of items) {
        const [inv] = this.sqlQuery<{ on_hand: number; reserved: number }>(
          `SELECT on_hand, reserved FROM inventory WHERE sku = ?`,
          [item.sku],
        );
        skuAvailability.push({
          sku: item.sku,
          available: inv ? Math.max(0, inv.on_hand - inv.reserved) : 0,
        });
      }
    });

    // Broadcast inventory updates after commit
    for (const { sku, available } of skuAvailability) {
      this.broadcast({
        type: 'inventory.updated',
        data: { sku, available },
        timestamp: new Date().toISOString(),
      });
    }

    if (alreadyFinalizedOrderId !== null) {
      return {
        ok: false,
        code: 'already_finalized',
        message: `Order already exists for Stripe session ${stripeSessionId}`,
        orderId: alreadyFinalizedOrderId,
      };
    }

    return {
      ok: true,
      orderId,
      orderNumber,
      customerId,
      items: orderItemsResult,
      skuAvailability,
    };
  }

  /**
   * Create a test order (no Stripe payment).
   * Validates SKUs, checks inventory, applies discount atomically.
   */
  createTestOrder(args: TestOrderArgs): TestOrderResult | DomainError {
    this.ensureInitialized();

    const { customerEmail, items: inputItems, discountCode } = args;

    let subtotal = 0;
    const orderItems: OrderItemPayload[] = [];
    let discountId: string | null = null;
    let finalDiscountCode: string | null = null;
    let discountAmountCents = 0;

    return this.ctx.storage.transactionSync(() => {
      // Validate items and compute subtotal
      for (const { sku, qty } of inputItems) {
        const [variant] = this.sqlQuery<{ title: string; price_cents: number; status: string }>(
          `SELECT title, price_cents, status FROM variants WHERE sku = ?`,
          [sku],
        );
        if (!variant)
          return {
            ok: false,
            code: 'sku_not_found' as const,
            message: `SKU not found: ${sku}`,
            details: { sku },
          };

        const [inv] = this.sqlQuery<{ on_hand: number; reserved: number }>(
          `SELECT on_hand, reserved FROM inventory WHERE sku = ?`,
          [sku],
        );
        const available = (inv?.on_hand ?? 0) - (inv?.reserved ?? 0);
        if (available < qty) {
          return {
            ok: false,
            code: 'insufficient_inventory' as const,
            message: `Insufficient inventory for SKU: ${sku}`,
            details: { sku },
          };
        }

        subtotal += variant.price_cents * qty;
        orderItems.push({ sku, title: variant.title, qty, unit_price_cents: variant.price_cents });
      }

      // Validate and reserve discount
      if (discountCode) {
        const normalizedCode = discountCode.toUpperCase().trim();
        const [discountRow] = this.sqlQuery<Record<string, unknown>>(
          `SELECT * FROM discounts WHERE code = ?`,
          [normalizedCode],
        );

        if (!discountRow) {
          return {
            ok: false,
            code: 'discount_invalid' as const,
            message: 'Discount code not found',
          };
        }

        const discount = discountRow as unknown as Discount;

        try {
          validateDiscountFields(discount, subtotal);
        } catch (err) {
          return {
            ok: false,
            code: 'discount_invalid' as const,
            message: err instanceof Error ? err.message : 'Discount is no longer valid',
          };
        }

        if (discount.usage_limit_per_customer !== null) {
          const [usage] = this.sqlQuery<{ count: number }>(
            `SELECT COUNT(*) as count FROM discount_usage WHERE discount_id = ? AND customer_email = ?`,
            [discount.id, customerEmail.toLowerCase()],
          );
          if (usage && usage.count >= discount.usage_limit_per_customer) {
            return {
              ok: false,
              code: 'discount_invalid' as const,
              message: 'You have already used this discount',
            };
          }
        }

        const currentTime = now();

        if (discount.usage_limit !== null) {
          const result = this.sqlRun(
            `UPDATE discounts
             SET usage_count = usage_count + 1, updated_at = ?
             WHERE id = ?
               AND status = 'active'
               AND (starts_at IS NULL OR starts_at <= ?)
               AND (expires_at IS NULL OR expires_at >= ?)
               AND usage_count < usage_limit`,
            [currentTime, discount.id, currentTime, currentTime],
          );
          if (result.changes === 0) {
            return {
              ok: false,
              code: 'discount_invalid' as const,
              message: 'Discount usage limit reached',
            };
          }
        } else {
          const result = this.sqlRun(
            `UPDATE discounts
             SET updated_at = ?
             WHERE id = ?
               AND status = 'active'
               AND (starts_at IS NULL OR starts_at <= ?)
               AND (expires_at IS NULL OR expires_at >= ?)`,
            [currentTime, discount.id, currentTime, currentTime],
          );
          if (result.changes === 0) {
            return {
              ok: false,
              code: 'discount_invalid' as const,
              message: 'Discount is no longer valid',
            };
          }
        }

        discountAmountCents = calculateDiscount(discount, subtotal);
        discountId = discount.id;
        finalDiscountCode = discount.code;
      }

      const totalCents = subtotal - discountAmountCents;
      const timestamp = now();

      // Upsert customer
      const [existingCustomer] = this.sqlQuery<{ id: string }>(
        `SELECT id FROM customers WHERE email = ?`,
        [customerEmail],
      );

      let customerId: string;
      if (existingCustomer) {
        customerId = existingCustomer.id;
        this.sqlRun(
          `UPDATE customers SET
            order_count = order_count + 1,
            total_spent_cents = total_spent_cents + ?,
            last_order_at = ?,
            updated_at = ?
          WHERE id = ?`,
          [totalCents, timestamp, timestamp, customerId],
        );
      } else {
        customerId = uuid();
        this.sqlRun(
          `INSERT INTO customers (id, email, order_count, total_spent_cents, last_order_at)
           VALUES (?, ?, 1, ?, ?)`,
          [customerId, customerEmail, totalCents, timestamp],
        );
      }

      const orderNumber = generateOrderNumber();
      const orderId = uuid();

      this.sqlRun(
        `INSERT INTO orders (id, customer_id, number, status, customer_email, subtotal_cents, tax_cents, shipping_cents, total_cents, discount_code, discount_id, discount_amount_cents, created_at)
         VALUES (?, ?, ?, 'paid', ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
        [
          orderId,
          customerId,
          orderNumber,
          customerEmail,
          subtotal,
          totalCents,
          finalDiscountCode,
          discountId,
          discountAmountCents,
          timestamp,
        ],
      );

      for (const item of orderItems) {
        this.sqlRun(
          `INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`,
          [uuid(), orderId, item.sku, item.title, item.qty, item.unit_price_cents],
        );
        this.sqlRun(
          `UPDATE inventory SET reserved = MAX(reserved - ?, 0), on_hand = on_hand - ?, updated_at = ? WHERE sku = ?`,
          [item.qty, item.qty, timestamp, item.sku],
        );
      }

      if (discountId && discountAmountCents > 0) {
        const [existingUsage] = this.sqlQuery<{ id: string }>(
          `SELECT id FROM discount_usage WHERE order_id = ? AND discount_id = ?`,
          [orderId, discountId],
        );
        if (!existingUsage) {
          this.sqlRun(
            `INSERT INTO discount_usage (id, discount_id, order_id, customer_email, discount_amount_cents)
             VALUES (?, ?, ?, ?, ?)`,
            [uuid(), discountId, orderId, customerEmail.toLowerCase(), discountAmountCents],
          );
        }
      }

      return {
        ok: true as const,
        order: {
          id: orderId,
          number: orderNumber,
          status: 'paid',
          customer_email: customerEmail,
          customer_id: customerId,
          subtotal_cents: subtotal,
          discount_amount_cents: discountAmountCents,
          tax_cents: 0,
          shipping_cents: 0,
          total_cents: totalCents,
          discount_code: finalDiscountCode,
          discount_id: discountId,
          currency: 'USD',
          created_at: timestamp,
          shipping_name: null,
          shipping_phone: null,
          ship_to: null,
          tracking_number: null,
          tracking_url: null,
          shipped_at: null,
          stripe_checkout_session_id: null,
          stripe_payment_intent_id: null,
        },
        items: orderItems,
      };
    }) as TestOrderResult | DomainError;
  }

  /**
   * Delete a product and all its variants/images/inventory atomically,
   * after checking that no variants have been ordered.
   */
  deleteProductCascade(productId: string): { ok: true } | DomainError {
    this.ensureInitialized();

    return this.ctx.storage.transactionSync(() => {
      const [product] = this.sqlQuery<{ id: string }>(`SELECT id FROM products WHERE id = ?`, [
        productId,
      ]);
      if (!product) {
        return { ok: false, code: 'product_not_found' as const, message: 'Product not found' };
      }

      const variants = this.sqlQuery<{ sku: string }>(
        `SELECT sku FROM variants WHERE product_id = ?`,
        [productId],
      );

      if (variants.length > 0) {
        const skus = variants.map((v) => v.sku);
        const placeholders = skus.map(() => '?').join(',');
        const [orderItem] = this.sqlQuery<{ id: string }>(
          `SELECT id FROM order_items WHERE sku IN (${placeholders}) LIMIT 1`,
          skus,
        );

        if (orderItem) {
          return {
            ok: false,
            code: 'product_has_orders' as const,
            message:
              'Cannot delete product with variants that have been ordered. Set status to draft instead.',
          };
        }

        for (const v of variants) {
          this.sqlRun(`DELETE FROM inventory WHERE sku = ?`, [v.sku]);
        }
      }

      this.sqlRun(`DELETE FROM product_images WHERE product_id = ?`, [productId]);
      this.sqlRun(`DELETE FROM variants WHERE product_id = ?`, [productId]);
      this.sqlRun(`DELETE FROM products WHERE id = ?`, [productId]);

      return { ok: true as const };
    }) as { ok: true } | DomainError;
  }

  /**
   * Atomically claim a Stripe event for processing using INSERT OR IGNORE.
   * Returns {claimed: true} if this call inserted the row (first delivery wins).
   * Returns {claimed: false} if the row already existed (duplicate delivery — safe to skip).
   */
  claimEvent(stripeEventId: string, type: string, payload: string): ClaimEventResult {
    this.ensureInitialized();
    const result = this.sqlRun(
      `INSERT OR IGNORE INTO events (id, stripe_event_id, type, payload) VALUES (?, ?, ?, ?)`,
      [uuid(), stripeEventId, type, payload],
    );
    return { claimed: result.changes > 0 };
  }

  /**
   * Release a previously claimed Stripe event so Stripe's next retry can reprocess it.
   * Called only when processing fails with an unexpected error — NOT for domain no-ops.
   */
  releaseEventClaim(stripeEventId: string): void {
    this.ensureInitialized();
    this.sqlRun(`DELETE FROM events WHERE stripe_event_id = ?`, [stripeEventId]);
  }

  // ─── WebSocket Authorization ────────────────────────────────────────────────

  /**
   * Determine WS role from a raw key forwarded via the internal X-WS-Key header.
   * Returns 'admin', 'public', or 'anon' (no/invalid key).
   */
  private async resolveWsRole(rawKey: string | null): Promise<'admin' | 'public' | 'anon'> {
    if (!rawKey) return 'anon';
    const data = new TextEncoder().encode(rawKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const keyHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const rows = this.sqlQuery<{ role: string }>(
      `SELECT role FROM api_keys WHERE key_hash = ? LIMIT 1`,
      [keyHash],
    );
    if (rows.length === 0) return 'anon';
    return rows[0].role === 'admin' ? 'admin' : 'public';
  }

  /**
   * Return true if an event type is publicly deliverable (no auth required).
   */
  private static isPublicEvent(eventType: string): boolean {
    return eventType === 'inventory.updated' || eventType === 'presence.count';
  }

  /**
   * Filter requested topics to those permitted for the given role.
   * Public / anon: only inventory.updated (via 'inventory' or exact) and presence.product.*.
   * Admin: all topics.
   */
  private static filterTopicsForRole(
    topics: string[],
    role: 'admin' | 'public' | 'anon',
  ): string[] {
    if (role === 'admin') return topics;
    return topics.filter((t) => {
      // Allow exact inventory.updated, bare 'inventory' prefix (maps to inventory.updated events),
      // and presence.product.* pattern
      return t === 'inventory.updated' || t === 'inventory' || t.startsWith('presence.product.');
    });
  }

  // ─── WebSocket Infrastructure ───────────────────────────────────────────────

  private broadcastPresenceCount(productId: string): void {
    const topic = `presence.product.${productId}`;
    let count = 0;
    for (const [, session] of this.sessions) {
      if (session.topics.has(topic)) count++;
    }
    const message = JSON.stringify({
      type: 'presence.count',
      data: { product_id: productId, count },
      timestamp: new Date().toISOString(),
    });
    for (const [ws, session] of this.sessions) {
      if (session.topics.has(topic)) {
        try {
          ws.send(message);
        } catch {
          this.sessions.delete(ws);
        }
      }
    }
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rawTopics = url.searchParams.get('topics')?.split(',') || ['*'];

    // Resolve role from the internal forwarding header (set by the worker fetch handler).
    // Client-supplied X-WS-Key values are overwritten by the worker, so we trust this header.
    const rawKey = request.headers.get('X-WS-Key');
    const role = await this.resolveWsRole(rawKey);

    // Filter topics down to those allowed for this role
    const allowedTopics = MerchantDO.filterTopicsForRole(rawTopics, role);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    this.sessions.set(server, { topics: new Set(allowedTopics), role });
    server.serializeAttachment({ topics: allowedTopics, role });

    for (const topic of allowedTopics) {
      const match = topic.match(/^presence\.product\.(.+)$/);
      if (match) this.broadcastPresenceCount(match[1]);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const data = JSON.parse(message as string);
      let session = this.sessions.get(ws);
      if (!session) {
        const attachment = ws.deserializeAttachment() as {
          topics: string[];
          role?: 'admin' | 'public' | 'anon';
        } | null;
        if (attachment) {
          session = { topics: new Set(attachment.topics), role: attachment.role ?? 'anon' };
          this.sessions.set(ws, session);
        } else {
          return;
        }
      }

      if (data.action === 'subscribe' && data.topic) {
        // Enforce topic policy: silently drop disallowed topics
        const [allowed] = MerchantDO.filterTopicsForRole([data.topic], session.role);
        if (!allowed) return;
        session.topics.add(allowed);
        ws.serializeAttachment({ topics: Array.from(session.topics), role: session.role });
        const match = allowed.match(/^presence\.product\.(.+)$/);
        if (match) this.broadcastPresenceCount(match[1]);
      } else if (data.action === 'unsubscribe' && data.topic) {
        session.topics.delete(data.topic);
        ws.serializeAttachment({ topics: Array.from(session.topics), role: session.role });
        const match = data.topic.match(/^presence\.product\.(.+)$/);
        if (match) this.broadcastPresenceCount(match[1]);
      }
    } catch {}
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const session = this.sessions.get(ws);
    const presenceTopics = session
      ? [...session.topics].filter((t) => t.startsWith('presence.product.'))
      : [];
    this.sessions.delete(ws);
    for (const topic of presenceTopics) {
      const match = topic.match(/^presence\.product\.(.+)$/);
      if (match) this.broadcastPresenceCount(match[1]);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const session = this.sessions.get(ws);
    const presenceTopics = session
      ? [...session.topics].filter((t) => t.startsWith('presence.product.'))
      : [];
    this.sessions.delete(ws);
    for (const topic of presenceTopics) {
      const match = topic.match(/^presence\.product\.(.+)$/);
      if (match) this.broadcastPresenceCount(match[1]);
    }
  }

  broadcast(event: WSEvent): void {
    const message = JSON.stringify(event);
    const eventTopic = event.type.split('.')[0];
    const isPublic = MerchantDO.isPublicEvent(event.type);

    for (const [ws, session] of this.sessions) {
      // Defense-in-depth: non-admin sessions only receive public events
      if (!isPublic && session.role !== 'admin') continue;

      if (
        session.topics.has('*') ||
        session.topics.has(eventTopic) ||
        session.topics.has(event.type)
      ) {
        try {
          ws.send(message);
        } catch {
          this.sessions.delete(ws);
        }
      }
    }
  }

  /**
   * Atomically finalize a UCP checkout session into an order after Stripe payment.
   *
   * Idempotent: if the UCP session is already 'completed' OR an order with this
   * stripe_checkout_session_id already exists, this is a no-op (returns ok:true
   * with the existing order data).
   *
   * NOTE: UCP sessions do NOT hold inventory reservations (unlike carts). There
   * is no release-on-cancel flow. We check on_hand at finalization time and clamp
   * decrements at 0 rather than failing — because the payment already succeeded.
   * Oversold items are flagged in the result for logging/alerting.
   */
  ucpFinalizeOrder(args: UCPFinalizeOrderArgs): UCPFinalizeOrderResult | DomainError {
    this.ensureInitialized();

    const { ucpSessionId, stripeSessionId, stripePaymentIntent } = args;

    let orderId = '';
    let orderNumber = '';
    let customerEmail = '';
    let currency = '';
    const orderItemsResult: OrderItemPayload[] = [];
    let oversold = false;
    let alreadyFinalizedOrderId: string | null = null;
    let alreadyFinalizedOrderNumber: string | null = null;
    let alreadyFinalizedEmail: string | null = null;
    let alreadyFinalizedCurrency: string | null = null;
    let alreadyFinalizedItems: OrderItemPayload[] = [];

    this.ctx.storage.transactionSync(() => {
      // Check if UCP session already completed (idempotency)
      const [session] = this.sqlQuery<{
        id: string;
        status: string;
        currency: string;
        line_items: string;
        buyer: string;
        totals: string;
        order_id: string | null;
        order_number: string | null;
        stripe_session_id: string | null;
      }>(`SELECT * FROM ucp_checkout_sessions WHERE id = ?`, [ucpSessionId]);

      if (!session) return;

      if (session.status === 'completed' && session.order_id) {
        // Already finalized — collect order data for idempotent return
        const existingItems = this.sqlQuery<{
          sku: string;
          title: string;
          qty: number;
          unit_price_cents: number;
        }>(`SELECT sku, title, qty, unit_price_cents FROM order_items WHERE order_id = ?`, [
          session.order_id,
        ]);
        const [existingOrder] = this.sqlQuery<{ customer_email: string; currency: string }>(
          `SELECT customer_email, currency FROM orders WHERE id = ?`,
          [session.order_id],
        );
        alreadyFinalizedOrderId = session.order_id;
        alreadyFinalizedOrderNumber = session.order_number ?? '';
        alreadyFinalizedEmail = existingOrder?.customer_email ?? '';
        alreadyFinalizedCurrency = existingOrder?.currency ?? session.currency;
        alreadyFinalizedItems = existingItems;
        return;
      }

      // Belt-and-braces: check for existing order with this Stripe session id
      const [existingOrder] = this.sqlQuery<{
        id: string;
        number: string;
        customer_email: string;
        currency: string;
      }>(
        `SELECT id, number, customer_email, currency FROM orders WHERE stripe_checkout_session_id = ?`,
        [stripeSessionId],
      );

      if (existingOrder) {
        const existingItems = this.sqlQuery<{
          sku: string;
          title: string;
          qty: number;
          unit_price_cents: number;
        }>(`SELECT sku, title, qty, unit_price_cents FROM order_items WHERE order_id = ?`, [
          existingOrder.id,
        ]);
        alreadyFinalizedOrderId = existingOrder.id;
        alreadyFinalizedOrderNumber = existingOrder.number;
        alreadyFinalizedEmail = existingOrder.customer_email;
        alreadyFinalizedCurrency = existingOrder.currency;
        alreadyFinalizedItems = existingItems;
        return;
      }

      const lineItems: Array<{
        id: string;
        item: { id: string; title?: string };
        quantity: number;
        unit_price: { amount: number; currency: string };
      }> = JSON.parse(session.line_items || '[]');

      const buyer: { email?: string } = JSON.parse(session.buyer || '{}');
      const totals: Array<{ type: string; amount: number }> = JSON.parse(session.totals || '[]');
      const grandTotal = totals.find((t) => t.type === 'grand_total')?.amount ?? 0;
      customerEmail = buyer.email ?? '';
      currency = session.currency;

      orderId = uuid();
      orderNumber = generateOrderNumber();

      this.sqlRun(
        `INSERT INTO orders (id, number, status, customer_email, subtotal_cents, tax_cents, shipping_cents, total_cents, currency, stripe_checkout_session_id, stripe_payment_intent_id)
         VALUES (?, ?, 'paid', ?, ?, 0, 0, ?, ?, ?, ?)`,
        [
          orderId,
          orderNumber,
          customerEmail,
          grandTotal,
          grandTotal,
          currency,
          stripeSessionId,
          stripePaymentIntent,
        ],
      );

      for (const li of lineItems) {
        const sku = li.item.id;
        const qty = li.quantity;
        const title = li.item.title ?? sku;
        const unitPrice = li.unit_price.amount;

        this.sqlRun(
          `INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`,
          [uuid(), orderId, sku, title, qty, unitPrice],
        );
        orderItemsResult.push({ sku, title, qty, unit_price_cents: unitPrice });

        // Deduct inventory; clamp at 0 — payment already succeeded,
        // so we must not fail. Flag oversell for upstream logging.
        const [inv] = this.sqlQuery<{ on_hand: number }>(
          `SELECT on_hand FROM inventory WHERE sku = ?`,
          [sku],
        );
        const currentOnHand = inv?.on_hand ?? 0;
        const actualDeduct = Math.min(qty, currentOnHand);
        if (actualDeduct < qty) oversold = true;

        if (actualDeduct > 0) {
          this.sqlRun(
            `UPDATE inventory SET on_hand = on_hand - ?, reserved = MAX(reserved - ?, 0), updated_at = ? WHERE sku = ?`,
            [actualDeduct, actualDeduct, now(), sku],
          );
        }

        this.sqlRun(
          `INSERT INTO inventory_logs (id, sku, delta, reason) VALUES (?, ?, ?, 'sale')`,
          [uuid(), sku, -actualDeduct],
        );
      }

      // Mark session completed
      this.sqlRun(
        `UPDATE ucp_checkout_sessions SET status = 'completed', order_id = ?, order_number = ?, updated_at = ? WHERE id = ?`,
        [orderId, orderNumber, now(), ucpSessionId],
      );
    });

    if (alreadyFinalizedOrderId !== null) {
      return {
        ok: true,
        orderId: alreadyFinalizedOrderId,
        orderNumber: alreadyFinalizedOrderNumber!,
        customerEmail: alreadyFinalizedEmail!,
        currency: alreadyFinalizedCurrency!,
        items: alreadyFinalizedItems,
        oversold: false,
      };
    }

    return {
      ok: true,
      orderId,
      orderNumber,
      customerEmail,
      currency,
      items: orderItemsResult,
      oversold,
    };
  }

  // ─── Idempotency Methods ────────────────────────────────────────────────────

  /**
   * Atomically claim an idempotency key for processing.
   *
   * Uses INSERT OR IGNORE so only one concurrent winner can insert a row.
   * State machine:
   *   insert succeeded (changes=1)         → 'new'   (caller must process + complete)
   *   row existed, response_status IS NULL → 'in_flight' (another request is processing)
   *   row existed, endpoint/req_hash diff  → 'conflict' (same key, different request body)
   *   row existed, response_status NOT NULL → 'replay' (cached response available)
   */
  idempotencyClaim(
    keyHash: string,
    endpoint: string,
    requestHash: string,
  ):
    | { state: 'new' }
    | { state: 'in_flight' }
    | { state: 'replay'; status: number; body: string }
    | { state: 'conflict' } {
    this.ensureInitialized();

    const result = this.ctx.storage.transactionSync(() => {
      const insertResult = this.sqlRun(
        `INSERT OR IGNORE INTO idempotency_keys (key_hash, endpoint, request_hash) VALUES (?, ?, ?)`,
        [keyHash, endpoint, requestHash],
      );

      if (insertResult.changes > 0) {
        return { state: 'new' as const };
      }

      // Row already existed — inspect it
      const [existing] = this.sqlQuery<{
        endpoint: string;
        request_hash: string;
        response_status: number | null;
        response_body: string | null;
      }>(
        `SELECT endpoint, request_hash, response_status, response_body FROM idempotency_keys WHERE key_hash = ?`,
        [keyHash],
      );

      if (!existing) {
        // Race: deleted between INSERT and SELECT — treat as new
        this.sqlRun(
          `INSERT OR IGNORE INTO idempotency_keys (key_hash, endpoint, request_hash) VALUES (?, ?, ?)`,
          [keyHash, endpoint, requestHash],
        );
        return { state: 'new' as const };
      }

      if (existing.endpoint !== endpoint || existing.request_hash !== requestHash) {
        return { state: 'conflict' as const };
      }

      if (existing.response_status === null) {
        return { state: 'in_flight' as const };
      }

      return {
        state: 'replay' as const,
        status: existing.response_status,
        body: existing.response_body!,
      };
    });

    return result as
      | { state: 'new' }
      | { state: 'in_flight' }
      | { state: 'replay'; status: number; body: string }
      | { state: 'conflict' };
  }

  /**
   * Store the response for a successfully claimed idempotency key.
   * Called after the handler completes (status < 500).
   */
  idempotencyComplete(keyHash: string, status: number, body: string): void {
    this.ensureInitialized();
    this.sqlRun(
      `UPDATE idempotency_keys SET response_status = ?, response_body = ? WHERE key_hash = ?`,
      [status, body, keyHash],
    );
  }

  /**
   * Delete a claimed idempotency key so the client can retry.
   * Called when the handler threw an error (do not cache failed/errored requests).
   */
  idempotencyRelease(keyHash: string): void {
    this.ensureInitialized();
    this.sqlRun(`DELETE FROM idempotency_keys WHERE key_hash = ?`, [keyHash]);
  }

  /**
   * Delete old analytics and operational records to bound table growth.
   *
   * Uses LIMIT-bounded subselects so each cron invocation (every 5 min) only
   * removes at most 1 000 rows per table — keeping each run cheap.
   *
   * Retention windows:
   *   analytics_events   — ANALYTICS_RETENTION_DAYS (90)
   *   analytics_sessions — ANALYTICS_RETENTION_DAYS (90), keyed on last_seen_at.
   *                        Sessions are deleted after their events (events-first
   *                        ordering) so the soft FK reference is already gone.
   *   events             — EVENTS_RETENTION_DAYS (30). This table doubles as the
   *                        Stripe webhook idempotency store (claimEvent). 30 days
   *                        is safe because Stripe retries at most ~3 days after
   *                        first delivery, so any row older than 30 days will
   *                        never be checked again.
   *   webhook_deliveries — DELIVERIES_RETENTION_DAYS (30).
   */
  async pruneOldData(): Promise<{
    analyticsEvents: number;
    analyticsSessions: number;
    stripeEvents: number;
    webhookDeliveries: number;
    idempotencyKeys: number;
  }> {
    this.ensureInitialized();

    // Delete analytics_events first so analytics_sessions soft-FK rows are
    // already gone before we prune sessions.
    const eventsResult = this.run(
      `DELETE FROM analytics_events
       WHERE id IN (
         SELECT id FROM analytics_events
         WHERE created_at < datetime('now', '-${ANALYTICS_RETENTION_DAYS} days')
         LIMIT 1000
       )`,
    );

    const sessionsResult = this.run(
      `DELETE FROM analytics_sessions
       WHERE id IN (
         SELECT id FROM analytics_sessions
         WHERE last_seen_at < datetime('now', '-${ANALYTICS_RETENTION_DAYS} days')
         LIMIT 1000
       )`,
    );

    const stripeEventsResult = this.run(
      `DELETE FROM events
       WHERE id IN (
         SELECT id FROM events
         WHERE processed_at < datetime('now', '-${EVENTS_RETENTION_DAYS} days')
         LIMIT 1000
       )`,
    );

    const deliveriesResult = this.run(
      `DELETE FROM webhook_deliveries
       WHERE id IN (
         SELECT id FROM webhook_deliveries
         WHERE created_at < datetime('now', '-${DELIVERIES_RETENTION_DAYS} days')
         LIMIT 1000
       )`,
    );

    const idempotencyResult = this.run(
      `DELETE FROM idempotency_keys
       WHERE key_hash IN (
         SELECT key_hash FROM idempotency_keys
         WHERE created_at < datetime('now', '-${IDEMPOTENCY_RETENTION_HOURS} hours')
         LIMIT 1000
       )`,
    );

    return {
      analyticsEvents: eventsResult.changes,
      analyticsSessions: sessionsResult.changes,
      stripeEvents: stripeEventsResult.changes,
      webhookDeliveries: deliveriesResult.changes,
      idempotencyKeys: idempotencyResult.changes,
    };
  }

  async cleanupExpiredCarts(): Promise<number> {
    this.ensureInitialized();

    const now_ = new Date().toISOString();

    // Phase 1: expire open carts past their expiry time
    const expiredCarts = this.query<{ id: string }>(
      `SELECT id FROM carts WHERE status = 'open' AND expires_at < ?`,
      [now_],
    );

    if (expiredCarts.length > 0) {
      const cartIds = expiredCarts.map((c) => c.id);
      const placeholders = cartIds.map(() => '?').join(',');

      const reservedItems = this.query<{ sku: string; qty: number }>(
        `SELECT sku, SUM(qty) as qty FROM cart_items WHERE cart_id IN (${placeholders}) GROUP BY sku`,
        cartIds,
      );

      this.ctx.storage.transactionSync(() => {
        for (const item of reservedItems) {
          this.sqlRun(`UPDATE inventory SET reserved = MAX(reserved - ?, 0) WHERE sku = ?`, [
            item.qty,
            item.sku,
          ]);
        }

        this.sqlRun(`UPDATE carts SET status = 'expired' WHERE id IN (${placeholders})`, cartIds);
        this.sqlRun(`DELETE FROM cart_items WHERE cart_id IN (${placeholders})`, cartIds);
      });

      // Broadcast inventory updates for each affected SKU
      for (const item of reservedItems) {
        const [inv] = this.query<{ on_hand: number; reserved: number }>(
          `SELECT on_hand, reserved FROM inventory WHERE sku = ?`,
          [item.sku],
        );
        const available = inv ? Math.max(0, inv.on_hand - inv.reserved) : 0;
        this.broadcast({
          type: 'inventory.updated',
          data: { sku: item.sku, available },
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Phase 2: release checked_out carts whose Stripe session has expired
    // (webhook lost or never delivered — acts as a cron fallback)
    const abandonedCarts = this.query<{ id: string }>(
      `SELECT id FROM carts WHERE status = 'checked_out' AND expires_at < ?`,
      [now_],
    );

    for (const { id: cartId } of abandonedCarts) {
      // releaseAbandonedCheckout is idempotent: safe to call even if a webhook
      // already processed the cart between the SELECT and this call
      this.releaseAbandonedCheckout(cartId);
    }

    // Phase 3: cancel expired UCP checkout sessions
    const expiredUCPResult = this.run(
      `UPDATE ucp_checkout_sessions SET status = 'canceled', updated_at = ?
       WHERE status NOT IN ('completed', 'canceled') AND expires_at < ?`,
      [now_, now_],
    );
    const expiredUCPCount = expiredUCPResult.changes;

    return expiredCarts.length + abandonedCarts.length + expiredUCPCount;
  }
}
