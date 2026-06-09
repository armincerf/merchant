# Building a Storefront

This guide covers the public API surface you need to build a storefront — listing products, managing a cart, running Stripe checkout, and subscribing to live inventory updates via WebSocket. The `example/` directory contains a working vanilla-JS reference implementation you can copy and adapt.

## Quick reference: example app

```
example/
  index.html          → product listing page
  cart.html           → cart page
  success.html        → post-checkout confirmation
  src/
    api.example.js    → API client template (copy to api.js and fill in your keys)
    main.js           → product listing logic
    cart.js           → localStorage cart state helpers
    cart-page.js      → cart page logic including checkout redirect
    success-page.js   → reads session_id from URL, clears cart
```

Copy `src/api.example.js` to `src/api.js` and update `API_URL` and `PUBLIC_KEY`:

```js
const API_URL = 'https://your-store.workers.dev';
const PUBLIC_KEY = 'pk_your_public_key_here';
```

## Authentication

Storefront operations use the public key (`pk_...`). Pass it as a Bearer token:

```
Authorization: Bearer pk_your_public_key
```

Browsers opening a WebSocket cannot send custom headers; use the `?key=` query parameter instead.

## Products

### List products

```js
const res = await fetch(`${API_URL}/v1/products?status=active&limit=20`, {
  headers: { Authorization: `Bearer ${PUBLIC_KEY}` },
});
const { items } = await res.json();
// items[].id, items[].title, items[].description, items[].image_url, items[].variants[]
```

Each product has a `variants` array. Each variant has:

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | UUID |
| `sku` | string | Stock-keeping unit; use this for cart operations |
| `title` | string | e.g. "Black / Medium" |
| `price_cents` | number | Price in cents |
| `image_url` | string \| null | |
| `status` | `"active"` \| `"draft"` | Only `active` variants should be shown |

Cursor-based pagination: if the response includes `pagination.next_cursor`, pass it as `?cursor=<value>` on the next request.

## Cart

The cart is a server-side resource. The example app stores a lightweight list of `{sku, qty, title, price_cents, image_url}` items in `localStorage` and syncs to the server only at checkout time. You can also sync immediately on every add-to-cart.

### Create a cart

```js
const res = await fetch(`${API_URL}/v1/carts`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${PUBLIC_KEY}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(), // recommended for safe retries
  },
  body: JSON.stringify({ customer_email: 'buyer@example.com' }),
});
const cart = await res.json();
// cart.id — hold onto this
```

Carts expire 30 minutes after creation. The `Idempotency-Key` header ensures that a retry due to a network error returns the same cart rather than creating a duplicate.

### Add items (incremental)

`POST /v1/carts/{id}/items/add` atomically reserves inventory as items are added (positive `qty`) and releases it as items are removed (negative `qty`):

```js
// Add 2 units of a SKU
await fetch(`${API_URL}/v1/carts/${cartId}/items/add`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${PUBLIC_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ sku: 'TEE-BLK-M', qty: 1 }),
});

// Remove 1 unit
await fetch(`${API_URL}/v1/carts/${cartId}/items/add`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${PUBLIC_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sku: 'TEE-BLK-M', qty: -1 }),
});
```

Returns the full cart payload. Returns 409 if inventory is insufficient.

Alternatively `POST /v1/carts/{id}/items` replaces all items at once (no incremental reservation; the example app uses this approach via `addItemsToCart`):

```js
await fetch(`${API_URL}/v1/carts/${cartId}/items`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${PUBLIC_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    items: [
      { sku: 'TEE-BLK-M', qty: 2 },
      { sku: 'HAT-RED', qty: 1 },
    ],
  }),
});
```

### Apply a discount code

```js
await fetch(`${API_URL}/v1/carts/${cartId}/apply-discount`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${PUBLIC_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: 'SUMMER20' }),
});
```

Remove a discount: `DELETE /v1/carts/{id}/discount`.

### Checkout — redirect to Stripe

```js
const res = await fetch(`${API_URL}/v1/carts/${cartId}/checkout`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${PUBLIC_KEY}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
  },
  body: JSON.stringify({
    success_url: 'https://your-store.com/success.html',
    cancel_url:  'https://your-store.com/cart.html',
    collect_shipping: true,
    shipping_countries: ['US', 'CA', 'GB', 'AU'],
  }),
});
const { checkout_url } = await res.json();
window.location.href = checkout_url;
```

Stripe opens a hosted checkout page. After payment Stripe redirects to `success_url?session_id=<stripe-session-id>`.

## Success page

The `success_url` receives a `?session_id=<value>` query parameter appended by Stripe. The example success page reads it from the URL and displays it:

```js
// success-page.js
const params = new URLSearchParams(window.location.search);
const sessionId = params.get('session_id');
```

You do not need to do anything with `session_id` on the client — Merchant processes the `checkout.session.completed` Stripe webhook server-side and creates the order automatically. The success page is purely for showing a confirmation to the buyer. The example also clears the localStorage cart on this page (`clearCart()`).

## Live inventory (WebSocket)

Connect with the public key via the `?key=` query parameter (browsers cannot set `Authorization` headers on WebSocket connections):

```js
const ws = new WebSocket(
  `wss://your-store.workers.dev/?topics=inventory&key=${PUBLIC_KEY}`
);

ws.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === 'inventory.updated') {
    const { sku, available } = event.data;
    updateStockBadge(sku, available);
  }
};
```

### Topics

| Topic string | Permitted for | Events delivered |
|---|---|---|
| `inventory` or `inventory.updated` | public (pk_ or no key) | `inventory.updated` — `{sku, available}` |
| `presence.product.<productId>` | public | `presence.count` — `{product_id, count}` |
| `*` | admin (sk_ only) | All event types |
| `order`, `order.*`, `cart`, `cart.*` | admin only | order/cart events |

Comma-separate multiple topics in the `?topics=` parameter:

```js
const ws = new WebSocket(
  `wss://your-store.workers.dev/?topics=inventory,presence.product.prod_abc123&key=${PUBLIC_KEY}`
);
```

Disallowed topics (e.g. `order` on a public key) are silently dropped.

### Product presence

Subscribing to `presence.product.<productId>` immediately triggers a `presence.count` event showing how many other connections are currently subscribed to that same topic:

```js
ws.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === 'presence.count') {
    // { product_id: 'prod_abc123', count: 4 }
    showViewers(event.data.product_id, event.data.count);
  }
};
```

Count updates are broadcast whenever any connection subscribes or disconnects from that topic.

### Subscribe / unsubscribe dynamically

After connecting you can add or remove topics by sending JSON messages:

```js
ws.send(JSON.stringify({ action: 'subscribe',   topic: 'inventory.updated' }));
ws.send(JSON.stringify({ action: 'unsubscribe', topic: 'presence.product.prod_abc123' }));
```

Topic authorization is checked on dynamic subscribe too — disallowed topics are silently ignored.

## Live inventory without WebSocket

For server-side rendering or environments where WebSocket is not available, poll the public availability endpoint:

```js
const res = await fetch(
  `${API_URL}/v1/inventory/available?skus=TEE-BLK-M,TEE-BLK-L`,
  // No Authorization header required — this endpoint is public
);
const { items } = await res.json();
// items: [{ sku: "TEE-BLK-M", available: 12 }, { sku: "TEE-BLK-L", available: 0 }]
```

`available` is `on_hand - reserved`. A value of `0` means sold out.

## Minimal end-to-end example

```js
// 1. Fetch products
const { items: products } = await fetch(`${API_URL}/v1/products?status=active`, {
  headers: { Authorization: `Bearer ${PUBLIC_KEY}` },
}).then(r => r.json());

// 2. Create cart
const cart = await fetch(`${API_URL}/v1/carts`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${PUBLIC_KEY}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
  },
  body: JSON.stringify({ customer_email: 'buyer@example.com' }),
}).then(r => r.json());

// 3. Add an item (incremental, with inventory reservation)
await fetch(`${API_URL}/v1/carts/${cart.id}/items/add`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${PUBLIC_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sku: products[0].variants[0].sku, qty: 1 }),
});

// 4. Checkout → Stripe redirect
const { checkout_url } = await fetch(`${API_URL}/v1/carts/${cart.id}/checkout`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${PUBLIC_KEY}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
  },
  body: JSON.stringify({
    success_url: `${window.location.origin}/success.html`,
    cancel_url:  `${window.location.origin}/cart.html`,
    collect_shipping: true,
    shipping_countries: ['US'],
  }),
}).then(r => r.json());

window.location.href = checkout_url;
```
