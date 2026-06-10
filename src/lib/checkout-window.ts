/**
 * Single source of truth for cart/checkout expiry horizons.
 *
 * The Stripe Checkout Session's `expires_at` and the cart row's `expires_at`
 * MUST come from the same instant: the cron releases inventory for
 * checked_out carts past their expiry, so if Stripe kept the session payable
 * longer than the cart (Stripe's default is 24 hours), a customer could pay
 * for a cart whose items were already released and resold (merchant-wie).
 * Always derive both values from one `checkoutWindow()` call.
 *
 * Stripe accepts `expires_at` between 30 minutes and 24 hours from creation.
 */

/** How long a newly created cart stays open before the cron expires it. */
export const OPEN_CART_TTL_MINUTES = 30;

/** How long a customer has to complete payment after starting checkout. */
export const CHECKOUT_WINDOW_MINUTES = 60;

export interface CheckoutWindow {
  /** Unix seconds — for Stripe's `expires_at` session parameter. */
  stripeExpiresAt: number;
  /** ISO 8601 — for the cart row's `expires_at` column. */
  cartExpiresAt: string;
}

export function checkoutWindow(nowMs = Date.now()): CheckoutWindow {
  // Rounded to a whole second so both representations are exactly equal
  // (Stripe's expires_at has second precision).
  const expiresMs = Math.floor((nowMs + CHECKOUT_WINDOW_MINUTES * 60 * 1000) / 1000) * 1000;
  return {
    stripeExpiresAt: expiresMs / 1000,
    cartExpiresAt: new Date(expiresMs).toISOString(),
  };
}
