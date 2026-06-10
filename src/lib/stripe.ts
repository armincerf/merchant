import Stripe from 'stripe';
import type { Database } from '../db';

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

export type StripeConfig = {
  secretKey: string | null;
  webhookSecret: string | null;
};

/**
 * Resolve Stripe credentials for ALL code paths (checkout, refunds, discount
 * sync, webhook verification, UCP).
 *
 * Source of truth is the `config` table row written by POST /v1/setup/stripe —
 * the documented setup path, rotatable at runtime without a redeploy. The
 * STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET env vars act as per-field
 * overrides (env wins when set) for local dev and tests.
 */
export async function getStripeConfig(
  db: Database,
  env?: { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string },
): Promise<StripeConfig> {
  let secretKey = env?.STRIPE_SECRET_KEY || null;
  let webhookSecret = env?.STRIPE_WEBHOOK_SECRET || null;
  if (secretKey && webhookSecret) return { secretKey, webhookSecret };

  const [row] = await db.query<{ value: string }>(
    `SELECT value FROM config WHERE key = 'stripe'`,
    [],
  );
  if (row) {
    try {
      const parsed = JSON.parse(row.value);
      secretKey = secretKey ?? (parsed.secret_key || null);
      webhookSecret = webhookSecret ?? (parsed.webhook_secret || null);
    } catch {
      // Malformed config row — treat as not configured rather than crash.
    }
  }
  return { secretKey, webhookSecret };
}
