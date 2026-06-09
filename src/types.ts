import {
  type CartPayload,
  type CheckoutReadyPayload,
  type ClaimEventResult,
  type DomainError,
  type FinalizeOrderArgs,
  type FinalizeOrderResult,
  type MerchantDO,
  type ReleaseAbandonedCheckoutResult,
  type TestOrderArgs,
  type TestOrderResult,
  type UCPFinalizeOrderArgs,
  type UCPFinalizeOrderResult,
} from './do';

export type Env = {
  MERCHANT: DurableObjectNamespace<MerchantDO>;
  IMAGES?: R2Bucket;
  IMAGES_URL?: string;
  STORE_NAME?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  BOOTSTRAP_SECRET?: string;
  /** Set to "true" to render the magic link in the OAuth HTML response (local dev only). */
  OAUTH_DEV_LINKS?: string;
};

export type DOStub = {
  query: <T = unknown>(sql: string, params: unknown[]) => Promise<T[]>;
  run: (sql: string, params: unknown[]) => Promise<{ changes: number }>;
  broadcast: (event: { type: string; data: unknown; timestamp: string }) => void;
  // Domain methods (atomic, single-RPC)
  cartReplaceItems: (
    cartId: string,
    items: Array<{ sku: string; qty: number }>,
  ) => Promise<CartPayload | DomainError>;
  cartAddItem: (cartId: string, sku: string, qty: number) => Promise<CartPayload | DomainError>;
  cartBeginCheckout: (cartId: string) => Promise<CheckoutReadyPayload | DomainError>;
  cartRevertCheckout: (cartId: string, releaseDiscountId?: string) => Promise<void>;
  releaseAbandonedCheckout: (cartId: string) => Promise<ReleaseAbandonedCheckoutResult>;
  finalizeOrderFromCart: (args: FinalizeOrderArgs) => Promise<FinalizeOrderResult | DomainError>;
  createTestOrder: (args: TestOrderArgs) => Promise<TestOrderResult | DomainError>;
  deleteProductCascade: (productId: string) => Promise<{ ok: true } | DomainError>;
  ucpFinalizeOrder: (args: UCPFinalizeOrderArgs) => Promise<UCPFinalizeOrderResult | DomainError>;
  // Stripe event idempotency
  claimEvent: (stripeEventId: string, type: string, payload: string) => Promise<ClaimEventResult>;
  releaseEventClaim: (stripeEventId: string) => Promise<void>;
};

export type Variables = {
  db: DOStub;
  auth: AuthContext;
};

export type HonoEnv = {
  Bindings: Env;
  Variables: Variables;
};

export type AuthRole = 'public' | 'admin' | 'oauth';

export type AuthContext = {
  role: AuthRole;
  stripeSecretKey: string | null;
  stripeWebhookSecret: string | null;
  oauthScopes?: string[];
  customerEmail?: string;
};

export class ApiError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }

  static unauthorized(message = 'Unauthorized') {
    return new ApiError('unauthorized', 401, message);
  }

  static forbidden(message = 'Forbidden') {
    return new ApiError('forbidden', 403, message);
  }

  static notFound(message = 'Not found') {
    return new ApiError('not_found', 404, message);
  }

  static invalidRequest(message: string, details?: Record<string, unknown>) {
    return new ApiError('invalid_request', 400, message, details);
  }

  static conflict(message: string) {
    return new ApiError('conflict', 409, message);
  }

  static insufficientInventory(sku: string) {
    return new ApiError('insufficient_inventory', 409, `Insufficient inventory for SKU: ${sku}`, {
      sku,
    });
  }

  static stripeError(message: string) {
    return new ApiError('stripe_error', 502, message);
  }
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

export function generateOrderNumber(): string {
  const now = new Date();
  const datePart = now.toISOString().slice(2, 10).replace(/-/g, '');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += chars.charAt(bytes[i] % chars.length);
  }
  return `ORD-${datePart}-${suffix}`;
}

export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
