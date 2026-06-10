/**
 * Schema migrations for MerchantDO's embedded SQLite database.
 *
 * The contract:
 *   - `MIGRATIONS` is append-only. Never edit, rename, or reorder an entry
 *     that has shipped — existing deployments have already recorded it as
 *     applied and will refuse to start on a history mismatch. To change the
 *     schema, append a new migration.
 *   - Each migration runs exactly once per deployment, inside its own
 *     transaction. If it throws, the transaction rolls back, nothing is
 *     recorded, and the next request retries it.
 *   - Applied migrations are recorded in the `schema_migrations` table.
 *     Durable Object SQLite does not authorize `PRAGMA user_version` (it
 *     fails with SQLITE_AUTH), so a regular table is the version marker.
 *
 * See CONTRIBUTING.md ("Schema migrations") for how to add a migration.
 */

export interface Migration {
  /**
   * Stable unique identifier, recorded in `schema_migrations`. Convention:
   * zero-padded sequence number plus a short slug, e.g. `002-add-fts-index`.
   */
  name: string;
  /**
   * Applies the migration. Runs inside a transaction together with the
   * bookkeeping insert; throw to roll back. `sql.exec()` accepts
   * multi-statement strings.
   */
  up(sql: SqlStorage): void;
}

/** The subset of `DurableObjectStorage` that `applyMigrations` needs. */
export interface MigrationStorage {
  readonly sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
}

const BASELINE_SCHEMA = `
-- Tables with no FK dependencies
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('public', 'admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  stripe_event_id TEXT UNIQUE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_stripe_event_id ON events(stripe_event_id);
CREATE INDEX IF NOT EXISTS idx_events_type_processed ON events(type, processed_at);

-- Products, images, variants
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT UNIQUE,
  description TEXT DEFAULT '',
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

CREATE TABLE IF NOT EXISTS product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id);

CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  weight_grams INTEGER,
  dims_cm TEXT,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_variants_sku ON variants(sku);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
CREATE INDEX IF NOT EXISTS idx_variants_status ON variants(status);

-- Inventory
CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  on_hand INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inventory_sku ON inventory(sku);

CREATE TABLE IF NOT EXISTS inventory_logs (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('restock', 'correction', 'damaged', 'return', 'sale', 'release')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inventory_logs_sku_created ON inventory_logs(sku, created_at);

-- Discounts (referenced by carts, orders, discount_usage)
CREATE TABLE IF NOT EXISTS discounts (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('percentage', 'fixed_amount')),
  value INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  min_purchase_cents INTEGER DEFAULT 0,
  max_discount_cents INTEGER,
  starts_at TEXT,
  expires_at TEXT,
  usage_limit INTEGER,
  usage_limit_per_customer INTEGER DEFAULT 1,
  usage_count INTEGER NOT NULL DEFAULT 0,
  stripe_coupon_id TEXT,
  stripe_promotion_code_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_discounts_code ON discounts(code);
CREATE INDEX IF NOT EXISTS idx_discounts_status ON discounts(status);

-- Customers (referenced by orders, oauth_tokens)
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  phone TEXT,
  password_hash TEXT,
  email_verified_at TEXT,
  auth_provider TEXT,
  auth_provider_id TEXT,
  accepts_marketing INTEGER DEFAULT 0,
  locale TEXT DEFAULT 'en',
  metadata TEXT,
  order_count INTEGER DEFAULT 0,
  total_spent_cents INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_order_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_last_order ON customers(last_order_at);
CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at);

CREATE TABLE IF NOT EXISTS customer_addresses (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label TEXT,
  is_default INTEGER DEFAULT 0,
  name TEXT,
  company TEXT,
  line1 TEXT NOT NULL,
  line2 TEXT,
  city TEXT NOT NULL,
  state TEXT,
  postal_code TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON customer_addresses(customer_id);

-- Carts (references discounts)
CREATE TABLE IF NOT EXISTS carts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out', 'expired')),
  customer_email TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  stripe_checkout_session_id TEXT,
  discount_code TEXT,
  discount_id TEXT REFERENCES discounts(id),
  discount_amount_cents INTEGER DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_carts_expires ON carts(expires_at);
CREATE INDEX IF NOT EXISTS idx_carts_status ON carts(status);

CREATE TABLE IF NOT EXISTS cart_items (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts(id),
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id ON cart_items(cart_id);

-- Orders (references customers, discounts)
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending', 'paid', 'processing', 'shipped', 'delivered', 'refunded', 'canceled')),
  customer_email TEXT NOT NULL,
  shipping_name TEXT,
  shipping_phone TEXT,
  ship_to TEXT,
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  discount_code TEXT,
  discount_id TEXT REFERENCES discounts(id),
  discount_amount_cents INTEGER DEFAULT 0,
  tracking_number TEXT,
  tracking_url TEXT,
  shipped_at TEXT,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_email_created ON orders(customer_email, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(number);
CREATE INDEX IF NOT EXISTS idx_orders_stripe_session ON orders(stripe_checkout_session_id);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  stripe_refund_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_refunds_order_id ON refunds(order_id);

-- Discount usage (references discounts, orders)
CREATE TABLE IF NOT EXISTS discount_usage (
  id TEXT PRIMARY KEY,
  discount_id TEXT NOT NULL REFERENCES discounts(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  customer_email TEXT NOT NULL,
  discount_amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_discount_usage_order ON discount_usage(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_usage_customer ON discount_usage(discount_id, customer_email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_usage_order_discount ON discount_usage(order_id, discount_id);

-- Webhooks
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhooks_status ON webhooks(status);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  response_code INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);

-- OAuth
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients(client_id);

CREATE TABLE IF NOT EXISTS oauth_authorizations (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  customer_email TEXT,
  magic_token_hash TEXT,
  magic_expires_at TEXT,
  code_hash TEXT,
  code_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'authorized', 'used', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_oauth_authorizations_client ON oauth_authorizations(client_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  access_token_hash TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_access ON oauth_tokens(access_token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_customer ON oauth_tokens(customer_id);

-- UCP checkout sessions
CREATE TABLE IF NOT EXISTS ucp_checkout_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'incomplete',
  currency TEXT NOT NULL,
  line_items TEXT NOT NULL,
  buyer TEXT,
  totals TEXT NOT NULL,
  messages TEXT,
  payment_instruments TEXT,
  stripe_session_id TEXT,
  order_id TEXT,
  order_number TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ucp_checkout_sessions_status ON ucp_checkout_sessions(status);
CREATE INDEX IF NOT EXISTS idx_ucp_checkout_sessions_stripe ON ucp_checkout_sessions(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_ucp_checkout_sessions_expires ON ucp_checkout_sessions(expires_at);

-- Analytics
CREATE TABLE IF NOT EXISTS analytics_sessions (
  id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  page_count INTEGER NOT NULL DEFAULT 0,
  ip_country TEXT,
  device_type TEXT CHECK (device_type IN ('mobile', 'desktop', 'tablet'))
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES analytics_sessions(id),
  event_type TEXT NOT NULL,
  event_data TEXT,
  page_path TEXT,
  referrer TEXT,
  user_agent TEXT,
  ip_country TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_type_created ON analytics_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_page_created ON analytics_events(page_path, created_at);

-- Idempotency keys (Stripe-style, 24-hour window)
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key_hash TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys(created_at);
`;

/**
 * Cache version counters for edge caching of public catalog reads.
 *
 * Worker-side middleware caches public catalog/availability GET responses in
 * the per-colo Cache API under keys that embed these counters, so bumping a
 * counter instantly invalidates every colo's entries (old keys never match
 * again). The bumps live in SQLite triggers rather than application code so
 * that no write path — route handler, DO domain method, cron, or future code
 * — can forget one.
 */
const CACHE_VERSIONS_SCHEMA = `
INSERT OR IGNORE INTO config (key, value) VALUES ('catalog_version', '1');
INSERT OR IGNORE INTO config (key, value) VALUES ('inventory_version', '1');

CREATE TRIGGER IF NOT EXISTS trg_products_ins_version AFTER INSERT ON products
BEGIN
  UPDATE config SET value = CAST(value AS INTEGER) + 1, updated_at = datetime('now') WHERE key = 'catalog_version';
END;
CREATE TRIGGER IF NOT EXISTS trg_products_upd_version AFTER UPDATE ON products
BEGIN
  UPDATE config SET value = CAST(value AS INTEGER) + 1, updated_at = datetime('now') WHERE key = 'catalog_version';
END;
CREATE TRIGGER IF NOT EXISTS trg_products_del_version AFTER DELETE ON products
BEGIN
  UPDATE config SET value = CAST(value AS INTEGER) + 1, updated_at = datetime('now') WHERE key = 'catalog_version';
END;

CREATE TRIGGER IF NOT EXISTS trg_variants_ins_version AFTER INSERT ON variants
BEGIN
  UPDATE config SET value = CAST(value AS INTEGER) + 1, updated_at = datetime('now') WHERE key = 'catalog_version';
END;
CREATE TRIGGER IF NOT EXISTS trg_variants_upd_version AFTER UPDATE ON variants
BEGIN
  UPDATE config SET value = CAST(value AS INTEGER) + 1, updated_at = datetime('now') WHERE key = 'catalog_version';
END;
CREATE TRIGGER IF NOT EXISTS trg_variants_del_version AFTER DELETE ON variants
BEGIN
  UPDATE config SET value = CAST(value AS INTEGER) + 1, updated_at = datetime('now') WHERE key = 'catalog_version';
END;

CREATE TRIGGER IF NOT EXISTS trg_product_images_ins_version AFTER INSERT ON product_images
BEGIN
  UPDATE config SET value = CAST(value AS INTEGER) + 1, updated_at = datetime('now') WHERE key = 'catalog_version';
END;
CREATE TRIGGER IF NOT EXISTS trg_product_images_upd_version AFTER UPDATE ON product_images
BEGIN
  UPDATE config SET value = CAST(value AS INTEGER) + 1, updated_at = datetime('now') WHERE key = 'catalog_version';
END;
CREATE TRIGGER IF NOT EXISTS trg_product_images_del_version AFTER DELETE ON product_images
BEGIN
  UPDATE config SET value = CAST(value AS INTEGER) + 1, updated_at = datetime('now') WHERE key = 'catalog_version';
END;

CREATE TRIGGER IF NOT EXISTS trg_inventory_ins_version AFTER INSERT ON inventory
BEGIN
  UPDATE config SET value = CAST(value AS INTEGER) + 1, updated_at = datetime('now') WHERE key = 'inventory_version';
END;
CREATE TRIGGER IF NOT EXISTS trg_inventory_upd_version AFTER UPDATE ON inventory
BEGIN
  UPDATE config SET value = CAST(value AS INTEGER) + 1, updated_at = datetime('now') WHERE key = 'inventory_version';
END;
CREATE TRIGGER IF NOT EXISTS trg_inventory_del_version AFTER DELETE ON inventory
BEGIN
  UPDATE config SET value = CAST(value AS INTEGER) + 1, updated_at = datetime('now') WHERE key = 'inventory_version';
END;
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    name: '001-baseline',
    up(sql) {
      sql.exec(BASELINE_SCHEMA);
      // Unique partial index on orders(stripe_checkout_session_id), guarded
      // with try/catch: deployments that predate the migrations framework may
      // contain duplicated session ids, and CREATE UNIQUE INDEX would throw
      // there. The application-level claimEvent guard still protects against
      // double-finalization; the index is defence-in-depth. If this warning
      // ever fires in a real deployment, ship a follow-up migration that
      // de-duplicates and recreates the index.
      try {
        sql.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_stripe_session_unique ON orders(stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL`,
        );
      } catch (err) {
        console.warn(
          'Could not create unique index on orders(stripe_checkout_session_id) — pre-existing duplicates detected. ' +
            'Ship a de-duplication migration to restore the index.',
          err,
        );
      }
    },
  },
  {
    name: '002-cache-versions',
    up(sql) {
      sql.exec(CACHE_VERSIONS_SCHEMA);
    },
  },
  {
    // Durable record of payments that arrived in a state we could not turn
    // into an order (e.g. checkout.session.completed for a cart whose
    // inventory was already released). The webhook handler auto-refunds and
    // records the outcome here so the merchant has a permanent audit trail
    // even if the alert webhook is never delivered.
    name: '003-payment-anomalies',
    up(sql) {
      sql.exec(`
CREATE TABLE IF NOT EXISTS payment_anomalies (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('orphaned_payment')),
  cart_id TEXT,
  stripe_checkout_session_id TEXT NOT NULL,
  stripe_payment_intent_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  customer_email TEXT,
  refund_id TEXT,
  refund_status TEXT NOT NULL CHECK (refund_status IN ('refunded', 'refund_failed', 'no_payment_intent')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payment_anomalies_created ON payment_anomalies(created_at);
CREATE INDEX IF NOT EXISTS idx_payment_anomalies_session ON payment_anomalies(stripe_checkout_session_id);
`);
    },
  },
];

/**
 * Brings the database up to date with `migrations`, applying any that are not
 * yet recorded in `schema_migrations`. Returns the number applied.
 *
 * - Each pending migration runs in its own transaction together with its
 *   bookkeeping insert, so a failure rolls back completely and the next call
 *   retries from the same point.
 * - A recorded migration whose position or name does not match the code is a
 *   hard error: it means a shipped migration was edited, renamed, or
 *   reordered, and continuing could corrupt the schema.
 * - A database with *more* recorded migrations than the code defines (a
 *   rolled-back deployment) is tolerated with a warning: migrations are
 *   additive, so older code runs fine against a newer schema.
 */
export function applyMigrations(
  storage: MigrationStorage,
  migrations: readonly Migration[],
): number {
  const { sql } = storage;
  sql.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = sql
    .exec('SELECT version, name FROM schema_migrations ORDER BY version')
    .toArray() as { version: number; name: string }[];

  for (let i = 0; i < Math.min(applied.length, migrations.length); i++) {
    if (applied[i].version !== i + 1 || applied[i].name !== migrations[i].name) {
      throw new Error(
        `Migration history mismatch at version ${i + 1}: database recorded ` +
          `"${applied[i].name}" (version ${applied[i].version}) but code defines ` +
          `"${migrations[i].name}". Migrations are append-only — never edit, ` +
          'rename, or reorder a migration that has shipped.',
      );
    }
  }

  if (applied.length > migrations.length) {
    console.warn(
      `Database has ${applied.length} migrations recorded but this build only defines ` +
        `${migrations.length} — running older code against a newer schema (rollback?). Continuing.`,
    );
    return 0;
  }

  let appliedNow = 0;
  for (let i = applied.length; i < migrations.length; i++) {
    const migration = migrations[i];
    storage.transactionSync(() => {
      migration.up(sql);
      sql.exec(
        'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
        i + 1,
        migration.name,
      );
    });
    appliedNow++;
  }
  return appliedNow;
}
