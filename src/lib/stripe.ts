import Stripe from 'stripe';

// Pinned API version — update deliberately when upgrading the SDK.
// The installed stripe@17 SDK's LatestApiVersion is '2025-02-24.acacia'.
const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2025-02-24.acacia';

/**
 * Construct a Stripe client with a pinned apiVersion so SDK upgrades
 * do not silently change the API contract.
 */
export function getStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
}
