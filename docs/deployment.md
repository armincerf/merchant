# Deployment

Merchant runs as a Cloudflare Worker with a single Durable Object (`MerchantDO`) for storage and a bound R2 bucket for images. Everything is declared in `wrangler.jsonc`; no manual Cloudflare dashboard steps are required.

## Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed and authenticated (`wrangler login`)
- Node.js 18+ for the init scripts
- A Stripe account (for payments; optional during initial setup)

## Deploy the Worker

```bash
npm install
wrangler deploy
```

On first deploy Cloudflare automatically provisions:

- The `MerchantDO` Durable Object (migration tag `v1`, new SQLite class)
- The `merchant-images` R2 bucket (binding `IMAGES`)

You will see the Worker URL in the deploy output (e.g. `https://merchant.<your-account>.workers.dev`).

## Initialize API keys

The `POST /v1/setup/init` endpoint creates the first public and admin keys. It only works when the database has zero keys.

Run the init script against your deployed Worker:

```bash
MERCHANT_URL=https://merchant.your-account.workers.dev \
  npx tsx scripts/init.ts --remote
```

The script generates a `pk_` (public) key and an `sk_` (admin) key, hashes them, and posts them to `/v1/setup/init`. **Save both keys** — they are displayed only once.

If you need to protect the init endpoint (e.g. multi-tenant or CI environments) set `BOOTSTRAP_SECRET`:

```bash
wrangler secret put BOOTSTRAP_SECRET
# Enter a random value when prompted
```

When `BOOTSTRAP_SECRET` is set, the `/v1/setup/init` endpoint requires the secret to be passed either as the `bootstrap_secret` query parameter or the `X-Bootstrap-Secret` request header:

```bash
curl -X POST "https://your-store.workers.dev/v1/setup/init?bootstrap_secret=<value>" \
  -H "Content-Type: application/json" \
  -d '{ "keys": [...] }'

# or via header:
curl -X POST https://your-store.workers.dev/v1/setup/init \
  -H "X-Bootstrap-Secret: <value>" \
  -H "Content-Type: application/json" \
  -d '{ "keys": [...] }'
```

## Connect Stripe

```bash
curl -X POST https://your-store.workers.dev/v1/setup/stripe \
  -H "Authorization: Bearer sk_your_admin_key" \
  -H "Content-Type: application/json" \
  -d '{
    "stripe_secret_key": "sk_live_...",
    "stripe_webhook_secret": "whsec_..."
  }'
```

Merchant validates the key against the Stripe balance endpoint before saving. The `stripe_webhook_secret` is optional at this step — you can add it after setting up the webhook in Stripe.

This is the single source of truth for Stripe credentials: checkout, refunds, discount sync, webhook verification, and UCP all read the keys saved here, and you can rotate them at any time by calling the endpoint again — no redeploy needed. (For local development, the `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` environment variables act as per-field overrides; see [Environment variables](#environment-variables).)

### Configure the Stripe webhook

In the Stripe dashboard (or via the Stripe CLI), create a webhook endpoint pointing to:

```
https://your-store.workers.dev/v1/webhooks/stripe
```

Subscribe to exactly these two events:

| Event | Purpose |
|-------|---------|
| `checkout.session.completed` | Creates the order, deducts inventory, dispatches `order.created` outbound webhooks |
| `checkout.session.expired` | Releases reserved inventory and discount usage for abandoned carts |

After creating the endpoint, copy the webhook signing secret (`whsec_...`) from Stripe and save it:

```bash
curl -X POST https://your-store.workers.dev/v1/setup/stripe \
  -H "Authorization: Bearer sk_your_admin_key" \
  -H "Content-Type: application/json" \
  -d '{
    "stripe_secret_key": "sk_live_...",
    "stripe_webhook_secret": "whsec_..."
  }'
```

For local development, use the Stripe CLI to forward events:

```bash
stripe listen --forward-to localhost:8787/v1/webhooks/stripe
```

## Environment variables

Set via `wrangler secret put <NAME>` for secrets, or in the `vars` block in `wrangler.jsonc` for non-secret values.

| Variable | Type | Purpose |
|----------|------|---------|
| `BOOTSTRAP_SECRET` | Secret | When set, gates `/v1/setup/init` behind `X-Bootstrap-Secret` header or `bootstrap_secret` query param |
| `IMAGES_URL` | Var | Public base URL for R2-served images (e.g. `https://images.your-store.com`). Leave empty if the R2 bucket is not publicly accessible. |
| `OAUTH_DEV_LINKS` | Var | Set to `"true"` in local dev only to render magic links in the OAuth HTML response. **Never set in production.** |
| `STORE_NAME` | Var | Store name shown in the OAuth consent page (optional; defaults to `"Store"`) |
| `STRIPE_SECRET_KEY` | Secret | Optional **override** for the Stripe secret key, intended for local dev/tests. Normal setup is `POST /v1/setup/stripe` (see above), which needs no env vars. When set, the env value wins over the stored config. |
| `STRIPE_WEBHOOK_SECRET` | Secret | Optional **override** for the Stripe webhook signing secret. Same semantics as `STRIPE_SECRET_KEY`. |

### R2 public access and `IMAGES_URL`

If you want product images served directly from R2, enable public access on the `merchant-images` bucket in the Cloudflare dashboard and set a custom domain or use the R2 public URL. Then set `IMAGES_URL` to that base URL:

```jsonc
// wrangler.jsonc
"vars": {
  "IMAGES_URL": "https://images.your-store.com"
}
```

Image keys are stored relative to this base URL. Without `IMAGES_URL`, the `GET /v1/images/{key}` endpoint still works by redirecting to a signed URL.

## Custom domains

Assign a custom domain to your Worker in the Cloudflare dashboard under **Workers & Pages → your worker → Custom Domains**. No changes to `wrangler.jsonc` are required.

## Cron job

`wrangler.jsonc` declares a cron trigger (`*/5 * * * *`). Cloudflare runs this every 5 minutes and calls three DO methods:

| Method | What it does |
|--------|-------------|
| `cleanupExpiredCarts` | Marks carts past their `expires_at` as expired |
| `pruneOldData` | Removes analytics events (> 90 days), Stripe event records (> 30 days), webhook deliveries (> 30 days), and idempotency keys (> 24 hours) |
| `retryFailedDeliveries` | Re-queues failed outbound webhook deliveries up to the 9-attempt cumulative cap |

## Seed demo data

After initializing, optionally seed products and inventory:

```bash
npx tsx scripts/seed.ts https://your-store.workers.dev sk_your_admin_key
```

## Checklist

- [ ] `wrangler deploy` succeeded
- [ ] `scripts/init.ts --remote` run; keys saved
- [ ] `BOOTSTRAP_SECRET` set if needed (before running init)
- [ ] `v1/setup/stripe` called with live key + webhook secret
- [ ] Stripe webhook endpoint created for `checkout.session.completed` and `checkout.session.expired`
- [ ] `IMAGES_URL` set if R2 public access is enabled
- [ ] `OAUTH_DEV_LINKS` is empty (not `"true"`) in production
