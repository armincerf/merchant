# Outbound Webhooks

Merchant can push events to your server as they happen — order created, inventory drops low, and so on. Each subscription has a secret; every delivery is signed so you can verify the payload came from your Merchant instance. Failed deliveries are retried automatically.

## Subscribing

All webhook management endpoints require an admin key (`sk_...`).

```bash
# Create a subscription
curl -X POST https://your-store.workers.dev/v1/webhooks \
  -H "Authorization: Bearer sk_your_admin_key" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-server.com/webhook",
    "events": ["order.created", "order.updated"]
  }'
```

Response (201) — the secret is returned **once** here and cannot be retrieved again:

```json
{
  "id": "wh_abc123",
  "url": "https://your-server.com/webhook",
  "events": ["order.created", "order.updated"],
  "status": "active",
  "secret": "whsec_e3b0c44298fc1c149afbf4c8996fb924...",
  "created_at": "2026-06-10T12:00:00.000Z"
}
```

Store the `secret` immediately — it is not recoverable.

## Endpoints

All under `/v1/webhooks`, all require admin auth.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/webhooks` | List all subscriptions |
| `POST` | `/v1/webhooks` | Create subscription (returns secret) |
| `GET` | `/v1/webhooks/{id}` | Get subscription with recent deliveries |
| `PATCH` | `/v1/webhooks/{id}` | Update URL, events, or status |
| `DELETE` | `/v1/webhooks/{id}` | Delete subscription and all its deliveries |
| `POST` | `/v1/webhooks/{id}/rotate-secret` | Generate a new secret |
| `GET` | `/v1/webhooks/{id}/deliveries/{deliveryId}` | Get a specific delivery |
| `POST` | `/v1/webhooks/{id}/deliveries/{deliveryId}/retry` | Manually retry a delivery |

### Update a subscription

```bash
curl -X PATCH https://your-store.workers.dev/v1/webhooks/wh_abc123 \
  -H "Authorization: Bearer sk_your_admin_key" \
  -H "Content-Type: application/json" \
  -d '{"events": ["*"], "status": "active"}'
```

Updatable fields: `url`, `events`, `status` (`active` or `paused`).

### Rotate the secret

```bash
curl -X POST https://your-store.workers.dev/v1/webhooks/wh_abc123/rotate-secret \
  -H "Authorization: Bearer sk_your_admin_key"
# {"secret": "whsec_newvalue..."}
```

The new secret takes effect immediately. Update your server before rotating.

## Event types

| Event | Pattern match | Fired when |
|-------|---------------|-----------|
| `order.created` | exact | A Stripe checkout session completes and the order is recorded |
| `order.updated` | exact | An order's status, tracking number, or other fields change |
| `order.shipped` | exact | An order's status is set to `shipped` |
| `order.refunded` | exact | A refund is processed |
| `inventory.low` | exact | A SKU's available quantity drops to 5 or below |

### Subscription patterns

| Pattern | Matches |
|---------|---------|
| `"order.created"` | Only `order.created` |
| `"order.*"` | Any event whose type starts with `order.` |
| `"*"` | All event types |

Pass any combination in the `events` array:

```json
{"events": ["order.*", "inventory.low"]}
```

## Payload shape

Every delivery is an HTTP `POST` with `Content-Type: application/json`. The body is a JSON object with these top-level fields:

```json
{
  "id": "delivery-uuid",
  "type": "order.created",
  "created_at": "2026-06-10T12:01:00.000Z",
  "data": { ... }
}
```

The `data` value for `order.created` and related order events:

```json
{
  "order": {
    "id": "order-uuid",
    "number": "ORD-0001",
    "status": "paid",
    "customer_email": "buyer@example.com",
    "customer_id": "cust-uuid-or-null",
    "amounts": {
      "subtotal_cents": 4900,
      "tax_cents": 0,
      "shipping_cents": 0,
      "total_cents": 4900,
      "currency": "USD"
    },
    "items": [
      {"sku": "TEE-BLK-M", "title": "Black Tee - M", "qty": 1, "unit_price_cents": 4900}
    ],
    "stripe": {
      "checkout_session_id": "cs_...",
      "payment_intent_id": "pi_..."
    }
  }
}
```

The `data` value for `inventory.low`:

```json
{"sku": "TEE-BLK-M", "available": 3, "threshold": 5}
```

## Delivery headers

| Header | Value |
|--------|-------|
| `X-Merchant-Signature` | HMAC-SHA256(secret, raw request body) as lowercase hex |
| `X-Merchant-Timestamp` | Unix epoch seconds at the time of delivery (integer) |
| `X-Merchant-Delivery-Id` | UUID identifying this specific delivery |
| `User-Agent` | `Merchant-Webhook/1.0` |
| `Content-Type` | `application/json` |

The signature is computed over the **raw request body** (the JSON string bytes), not a parsed/re-serialized form.

## Verifying the signature

### JavaScript (Cloudflare Workers / Node.js with Web Crypto API)

```js
async function verifyMerchantSignature(request, secret) {
  const signature = request.headers.get('X-Merchant-Signature');
  if (!signature) return false;

  const body = await request.text(); // raw bytes, do not parse first

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const sigBytes = Uint8Array.from(
    signature.match(/.{2}/g).map((b) => parseInt(b, 16)),
  );

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    encoder.encode(body),
  );
  return valid;
}
```

### Python

```python
import hashlib
import hmac

def verify_merchant_signature(body_bytes: bytes, secret: str, signature: str) -> bool:
    expected = hmac.new(
        secret.encode('utf-8'),
        body_bytes,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)

# In your handler (e.g. Flask/FastAPI):
# body = await request.body()        # bytes
# sig  = request.headers['X-Merchant-Signature']
# ok   = verify_merchant_signature(body, WEBHOOK_SECRET, sig)
```

Always use a constant-time comparison (`hmac.compare_digest` / `crypto.subtle.verify`) to avoid timing attacks.

## Retry semantics

Delivery uses at-least-once semantics. On the initial dispatch Merchant makes up to **3 attempts** with exponential backoff (delays of 1 s, 2 s). If all three fail the delivery is left in `failed` status.

The cron job (runs every 5 minutes) picks up any delivery that is still `failed`, has fewer than **9 cumulative attempts**, and was created within the last **24 hours**. Each cron run issues up to 3 more attempts with the same exponential-backoff pattern.

The maximum total attempts is **9** (3 immediate + up to 2 cron retry runs × 3). Once a delivery reaches 9 attempts or the 24-hour window expires, automatic retries stop. You can still trigger a manual retry via `POST /v1/webhooks/{id}/deliveries/{deliveryId}/retry` as long as the cumulative attempt count is below 9.

Merchant will **not** retry if the endpoint returns a 4xx response other than 429.

## Inspecting deliveries

`GET /v1/webhooks/{id}` returns the 20 most recent deliveries inline. For a specific delivery's full payload and response body:

```bash
curl https://your-store.workers.dev/v1/webhooks/wh_abc123/deliveries/delivery-uuid \
  -H "Authorization: Bearer sk_your_admin_key"
```

Delivery status values: `pending`, `success`, `failed`.
