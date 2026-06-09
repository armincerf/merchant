# OAuth 2.0 + PKCE and the Universal Commerce Protocol (UCP)

Merchant implements OAuth 2.0 Authorization Code flow with mandatory PKCE (S256) so that platforms and AI agents can act on behalf of customers. The same infrastructure backs the [Universal Commerce Protocol](https://ucp.dev) checkout session API.

## OAuth 2.0 overview

The flow uses a magic-link email instead of a password: after the customer submits their email address the server generates a short-lived link; clicking it issues an authorization code that the client exchanges for tokens.

> **Note on email delivery.** There is currently no email service wired up. In local development set `OAUTH_DEV_LINKS=true` in `wrangler.jsonc` `vars` to render the magic link directly in the browser. **Never set `OAUTH_DEV_LINKS=true` in production** — it exposes sign-in links to anyone who submits the authorization form.

## Discovery

```bash
GET /.well-known/oauth-authorization-server
```

Returns the standard OAuth 2.0 metadata document including the authorization endpoint, token endpoint, revocation endpoint, supported scopes, and PKCE methods (`S256` only).

## Scopes

| Scope | Description shown in consent UI |
|-------|----------------------------------|
| `openid` | Verify your identity |
| `profile` | Access your name and email |
| `checkout` | Create orders on your behalf |
| `orders.read` | View your order history |
| `orders.write` | Manage your orders |
| `addresses.read` | Access your saved addresses |
| `addresses.write` | Manage your addresses |
| `ucp:scopes:checkout_session` | Create and manage checkout sessions |
| `ucp:scopes:order` | Access order information and updates |
| `ucp:scopes:identity` | Link your account |

Request multiple scopes space-separated: `scope=openid%20profile%20checkout`.

## PKCE flow walkthrough

### Step 1 — Generate verifier and challenge

```bash
# Generate a random 32-byte verifier (URL-safe base64 or hex)
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d '=+/' | head -c 43)

# SHA-256 the verifier, base64url-encode (no padding)
CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=')

echo "verifier:  $CODE_VERIFIER"
echo "challenge: $CODE_CHALLENGE"
```

### Step 2 — Redirect to the authorization endpoint

```bash
STATE=$(openssl rand -hex 16)

AUTHORIZE_URL="https://your-store.workers.dev/oauth/authorize\
?client_id=my-app\
&redirect_uri=https%3A%2F%2Fmy-app.example.com%2Fcallback\
&response_type=code\
&scope=openid%20profile%20checkout\
&state=$STATE\
&code_challenge=$CODE_CHALLENGE\
&code_challenge_method=S256"

echo "Open: $AUTHORIZE_URL"
```

Required query parameters:

| Parameter | Value |
|-----------|-------|
| `client_id` | Any string identifying your application; auto-registered on first use |
| `redirect_uri` | Must be an HTTP(S) URL; registered on first use, must match on subsequent calls |
| `response_type` | Must be `code` |
| `scope` | Space-separated list from the scopes table above |
| `state` | Random string — returned on redirect for CSRF protection |
| `code_challenge` | Base64url(SHA-256(code_verifier)) — no padding |
| `code_challenge_method` | Must be `S256` |

The authorization endpoint renders a login page. The authorization session expires in **10 minutes**.

### Step 3 — Customer submits email

The browser renders a consent page listing the requested permissions. The customer enters their email and submits. Merchant generates a magic link and (in production) emails it; the server renders a "check your email" page.

### Step 4 — Customer clicks the magic link

```
GET /oauth/verify?token=<magic-token>&auth=<auth-id>
```

This is handled automatically — the customer clicks the link. The magic link expires in **15 minutes**. On success Merchant redirects to `redirect_uri` with `code` and `state` appended:

```
https://my-app.example.com/callback?code=<auth-code>&state=<your-state>
```

The authorization code expires in **5 minutes**.

### Step 5 — Exchange the code for tokens

```bash
curl -X POST https://your-store.workers.dev/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "<auth-code>",
    "redirect_uri": "https://my-app.example.com/callback",
    "client_id": "my-app",
    "code_verifier": "<original-code-verifier>"
  }'
```

Response:

```json
{
  "access_token": "64-char-hex-token",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "64-char-hex-token",
  "scope": "openid profile checkout"
}
```

Access tokens expire in **1 hour**. Refresh tokens expire in **30 days**.

### Step 6 — Use the token

Pass the access token the same way as an API key:

```bash
curl https://your-store.workers.dev/ucp/v1/checkout-sessions \
  -H "Authorization: Bearer <access-token>" \
  ...
```

### Step 7 — Refresh the access token

```bash
curl -X POST https://your-store.workers.dev/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "refresh_token",
    "refresh_token": "<refresh-token>",
    "client_id": "my-app"
  }'
```

Returns a new `access_token` and `expires_in`; the same refresh token remains valid until it expires.

### Revoke a token

```bash
curl -X POST https://your-store.workers.dev/oauth/revoke \
  -d "token=<access-or-refresh-token>"
```

Accepts `application/x-www-form-urlencoded`. Deletes the token record; passing an already-revoked or unknown token still returns `{"revoked": true}`.

## UCP — Universal Commerce Protocol

### Discovery

```bash
GET /.well-known/ucp   # public, no auth required
```

Returns the UCP profile: service endpoints, capability declarations, and (when Stripe is configured) the available payment handler (`stripe_checkout`, type `REDIRECT`).

### Authentication

All `/ucp/v1/*` endpoints require authentication — any valid API key (`pk_` or `sk_`) or a valid OAuth access token. For OAuth tokens the `ucp:scopes:checkout_session` scope is required for checkout-session routes; API keys bypass scope checks.

### Checkout session lifecycle

Sessions move through these statuses:

| Status | Meaning |
|--------|---------|
| `incomplete` | One or more items could not be resolved or are out of stock |
| `requires_escalation` | Buyer needs to take an action (e.g. redirect to Stripe) |
| `ready_for_complete` | All items resolved, no errors — safe to call `/complete` |
| `complete_in_progress` | `/complete` was called; Stripe session created |
| `completed` | Payment confirmed via Stripe webhook |
| `canceled` | Canceled by caller or expired (6-hour TTL) |

Sessions do **not** hold inventory reservations. Availability is checked at create time and again at `/complete` time, but no stock is reserved between those calls. This is a deliberate trade-off: if stock is exhausted between session creation and completion the `/complete` call returns `incomplete` (409) with a message listing the affected SKUs.

### Create a checkout session

```bash
curl -X POST https://your-store.workers.dev/ucp/v1/checkout-sessions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "currency": "USD",
    "line_items": [
      {
        "item": {"id": "TEE-BLK-M"},
        "quantity": 2
      }
    ],
    "buyer": {
      "email": "buyer@example.com",
      "first_name": "Alex"
    }
  }'
```

The `item.id` can be a variant UUID or a SKU string. Response is 201 with a full UCP session envelope.

### Get / update / cancel

```bash
GET    /ucp/v1/checkout-sessions/{id}
PUT    /ucp/v1/checkout-sessions/{id}    # full replacement of line_items / buyer / currency
DELETE /ucp/v1/checkout-sessions/{id}   # cancels; cannot cancel a completed session
```

`GET` automatically marks the session `canceled` if it has passed its `expires_at`.

### Complete a checkout session (Stripe redirect)

```bash
curl -X POST https://your-store.workers.dev/ucp/v1/checkout-sessions/{id}/complete \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "payment_data": {
      "handler_id": "stripe_checkout",
      "success_url": "https://my-app.example.com/success",
      "cancel_url":  "https://my-app.example.com/cancel"
    }
  }'
```

The session must be in `ready_for_complete` state. If Stripe is configured and `handler_id` is `stripe_checkout`, Merchant creates a Stripe Checkout session and returns:

```json
{
  "status": "requires_escalation",
  "continue_url": "https://checkout.stripe.com/...",
  ...
}
```

Redirect the buyer to `continue_url`. After payment Stripe fires `checkout.session.completed` to `/v1/webhooks/stripe`, which finalizes the UCP session and creates an order.

If any item is out of stock at complete time the endpoint returns 409 with `status: "incomplete"` and `messages` listing affected SKUs. Adjust quantities and retry.

### Payment handler shape

The `payment` object in every response follows the UCP payment handler schema:

```json
{
  "payment": {
    "handlers": [
      {
        "id": "stripe_checkout",
        "name": "com.stripe.checkout",
        "version": "2026-01-11",
        "spec": "https://stripe.com/docs/payments/checkout",
        "instrument_schemas": [
          "https://ucp.dev/schemas/shopping/types/card_payment_instrument.json"
        ],
        "config": {"type": "REDIRECT"}
      }
    ]
  }
}
```

Handlers are only present when Stripe is configured. When Stripe is not configured the `handlers` array is empty.
