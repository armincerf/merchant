// ============================================================
// RATE LIMIT CONFIGURATION
// ============================================================
// Easy to update - just modify these values
// Limits are per API key (or IP), per window, per endpoint scope

export type RateLimitConfig = {
  requests: number; // Max requests allowed
  windowMs: number; // Time window in milliseconds
};

export const rateLimits = {
  // Default for all endpoints
  default: {
    requests: 100,
    windowMs: 60 * 1000, // 1 minute
  },

  // Per-role overrides (RESERVED for future authenticated-stage use).
  // Role detection based on unverified key prefixes (sk_/pk_) was removed
  // because it allowed callers to claim a higher limit without authentication.
  // These values are kept for reference but are NOT applied pre-auth.
  roles: {
    admin: {
      requests: 500,
      windowMs: 60 * 1000,
    },
    public: {
      requests: 60,
      windowMs: 60 * 1000,
    },
  },

  // Per endpoint overrides (path prefix -> config)
  // More specific paths take precedence
  endpoints: {
    // OAuth endpoints — unlimited before, now capped
    '/oauth': {
      requests: 20,
      windowMs: 60 * 1000,
    },
    // Checkout is rate limited more strictly to prevent abuse
    '/v1/carts': {
      requests: 30,
      windowMs: 60 * 1000,
    },
    // Webhooks from Stripe need higher limits
    '/v1/webhooks/stripe': {
      requests: 1000,
      windowMs: 60 * 1000,
    },
    // Images upload is expensive
    '/v1/images': {
      requests: 20,
      windowMs: 60 * 1000,
    },
    // Analytics events from frontend (fire-and-forget)
    '/v1/analytics': {
      requests: 60,
      windowMs: 60 * 1000,
    },
  },

  // IPs/keys to never rate limit (e.g., internal services)
  // Add API key prefixes or full keys here
  whitelist: [] as string[],

  // Whether to include rate limit headers in responses
  includeHeaders: true,
} as const;

export type LimitResult = {
  config: RateLimitConfig;
  /** Scope string used as part of the counter key to isolate per-endpoint budgets. */
  scope: string;
};

// Helper to get limit for a specific request
export function getLimitForRequest(path: string): LimitResult {
  // Check endpoint-specific overrides first (longest match wins)
  let bestPrefix = '';
  let bestConfig: RateLimitConfig | null = null;

  for (const [prefix, config] of Object.entries(rateLimits.endpoints)) {
    if (path.startsWith(prefix) && prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
      bestConfig = config;
    }
  }

  if (bestConfig) {
    return { config: bestConfig, scope: bestPrefix };
  }

  // Fall back to default
  return { config: rateLimits.default, scope: 'default' };
}
