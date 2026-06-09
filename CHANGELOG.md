# Changelog

## Unreleased

### Added

- `CONTRIBUTING.md` with setup, test, lint, and PR convention guide
- `GET /v1/inventory/available` — public endpoint returning available stock (on_hand − reserved) for a list of SKUs; no auth required
- `POST /v1/carts/{id}/items/add` — incremental single-item add/remove with atomic inventory reservation (positive qty adds, negative removes)
- `POST /v1/carts/{id}/apply-discount` and `DELETE /v1/carts/{id}/discount` — discount code application on carts
- `GET /v1/analytics/events`, `GET /v1/analytics/summary`, `GET /v1/analytics/funnel` — event tracking and aggregated analytics with bot detection
- `/v1/discounts` CRUD (list, get, create, update, delete/deactivate) with Stripe coupon sync
- `/v1/keys` CRUD (list, create, revoke) for API key management
- `POST /v1/webhooks/{id}/deliveries/{deliveryId}/retry` — manual webhook delivery retry endpoint
- Mermaid architecture diagram and "Design & scaling model" section in README
- "Security model" section in README covering key roles, OAuth, webhook HMAC, WS topic auth, rate-limiting caveat, and idempotency

### Changed

- README clone URL corrected from `github.com/ygwyg/merchant` to `github.com/armincerf/merchant`
- README badges added: CI, License MIT, TypeScript
- README API reference expanded to cover analytics, discounts, keys, and incremental cart endpoints added during this polish effort
- README WebSocket event types updated to include `presence.count` (matches `WSEventType` in `src/do.ts`)
- README rate-limiting section now documents the in-memory/per-isolate caveat honestly
- README "Development" section added covering typecheck, lint, test commands and vitest-pool-workers
- CHANGELOG updated with Unreleased section covering this polish effort

### Fixed

- UCP routes now require authentication (was previously open)
- Multi-step cart/order mutations moved into atomic `transactionSync` DO methods — eliminates partial-write races
- Webhook retry logic is cumulative (max 9 total attempts including initial 3); README delivery semantics updated to match
- OAuth HTML interpolations escaped to prevent XSS; dev magic link gated behind environment flag
- WebSocket order/cart events restricted to admin keys at broadcast time (defense-in-depth)
- Idempotency keys scoped per API key; `5xx` responses not cached so clients can retry

### Security

- API keys stored as SHA-256 hashes; plaintext never persisted
- Last admin key deletion blocked to prevent lockout
- Stripe webhook events claimed atomically before processing to prevent duplicate order creation
- Abandoned checkout sessions release reserved inventory and discount reservations on expiry

## 0.2.0 (2025-01-11)

This release is a significant architecture overhaul focused on performance, real-time capabilities, and agent interoperability.

### Breaking Changes

- **D1 replaced with Durable Objects**: The database layer now uses Cloudflare Durable Objects with embedded SQLite instead of D1. This provides single-digit millisecond latency and native WebSocket support. Existing D1 users should run the migration script before upgrading (see README).

### New Features

- **Real-time updates via WebSocket**: Connect to `/ws` for live events (cart updates, order status, inventory changes). Subscribe to specific topics or get everything.

- **Full UCP (Universal Commerce Protocol) implementation**: Implements the [UCP spec](https://ucp.dev) for AI agent-to-commerce interoperability:
  - `GET /.well-known/ucp` — Discovery endpoint with capabilities, services, and payment handlers
  - `POST /ucp/v1/checkout-sessions` — Create checkout sessions
  - `GET /ucp/v1/checkout-sessions/:id` — Get checkout session
  - `PUT /ucp/v1/checkout-sessions/:id` — Update checkout session (full replacement)
  - `POST /ucp/v1/checkout-sessions/:id/complete` — Complete checkout (returns Stripe redirect URL)
  - `DELETE /ucp/v1/checkout-sessions/:id` — Cancel checkout session
  - Capabilities: `dev.ucp.shopping.checkout`, `dev.ucp.common.identity_linking`, `dev.ucp.shopping.order`
  - UCP envelope in all responses with version and active capabilities
  - Stripe Checkout payment handler with redirect flow
  - Order creation via Stripe webhook completion

- **OAuth 2.0 support**: Full OAuth 2.0 implementation with PKCE for platforms and AI agents to act on behalf of customers. Discovery at `/.well-known/oauth-authorization-server`.

- **D1 migration script**: `scripts/migrate-d1-to-do.ts` exports data from D1 and imports into the new Durable Object storage.

### Improvements

- Database queries now use RPC calls to a single Durable Object, eliminating cold start variability
- WebSocket connections are handled natively by the DO, no external pubsub needed
- Simplified wrangler config with auto-provisioning

### Documentation

- Updated all documentation (README, llms.txt, llms-full.txt, api.md, index.html) to reflect the new architecture
- Added comprehensive UCP documentation with API reference and examples
- Added OAuth 2.0 documentation
- Added WebSocket real-time documentation
