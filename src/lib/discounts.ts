/**
 * Shared discount logic used by both route handlers and Durable Object methods.
 *
 * calculateDiscount is pure. validateDiscountFields handles all checks that
 * don't require a DB query. The DO methods perform the per-customer usage query
 * synchronously via SqlStorage; route handlers use the async Database wrapper.
 */

import { ApiError, now } from '../types';

type DiscountType = 'percentage' | 'fixed_amount';

export interface Discount {
  id: string;
  code: string | null;
  type: DiscountType;
  value: number;
  status: string;
  min_purchase_cents: number;
  max_discount_cents: number | null;
  starts_at: string | null;
  expires_at: string | null;
  usage_limit: number | null;
  usage_limit_per_customer: number | null;
  usage_count: number;
  stripe_coupon_id: string | null;
  stripe_promotion_code_id: string | null;
}

/**
 * Pure validation that requires no DB access.
 * Throws ApiError for any failure.
 */
export function validateDiscountFields(discount: Discount, subtotalCents: number): void {
  if (discount.status !== 'active') {
    throw ApiError.invalidRequest('Discount is not active');
  }

  const currentTime = now();
  if (discount.starts_at && currentTime < discount.starts_at) {
    throw ApiError.invalidRequest('Discount has not started yet');
  }
  if (discount.expires_at && currentTime > discount.expires_at) {
    throw ApiError.invalidRequest('Discount has expired');
  }

  if (discount.min_purchase_cents > 0 && subtotalCents < discount.min_purchase_cents) {
    throw ApiError.invalidRequest(
      `Minimum purchase of $${(discount.min_purchase_cents / 100).toFixed(2)} required`,
    );
  }

  if (discount.usage_limit !== null && discount.usage_count >= discount.usage_limit) {
    throw ApiError.invalidRequest('Discount usage limit reached');
  }
}

/**
 * Calculate the discount amount in cents for a given subtotal.
 */
export function calculateDiscount(discount: Discount, subtotalCents: number): number {
  switch (discount.type) {
    case 'percentage': {
      let amount = Math.floor((subtotalCents * discount.value) / 100);
      if (discount.max_discount_cents !== null && amount > discount.max_discount_cents) {
        amount = discount.max_discount_cents;
      }
      return amount;
    }
    case 'fixed_amount': {
      return Math.min(discount.value, subtotalCents);
    }
    default:
      return 0;
  }
}
