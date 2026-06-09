import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { MerchantDO } from './do';
import { retryFailedDeliveries } from './lib/webhooks';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { analytics } from './routes/analytics';
import { catalog } from './routes/catalog';
import { checkout } from './routes/checkout';
import { customers } from './routes/customers';
import { discounts } from './routes/discounts';
import { images } from './routes/images';
import { inventory } from './routes/inventory';
import { keys } from './routes/keys';
import { oauth } from './routes/oauth';
import { orders } from './routes/orders';
import { setup } from './routes/setup';
import { ucp } from './routes/ucp';
import { webhooks } from './routes/webhooks';
import { webhooksRoutes } from './routes/webhooks-outbound';
import { ApiError, type DOStub, type Env, VERSION } from './types';

export { MerchantDO };

type Variables = {
  db: DOStub;
};

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

app.use('*', cors());

app.use('*', async (c, next) => {
  const id = c.env.MERCHANT.idFromName('default');
  const stub = c.env.MERCHANT.get(id);
  c.set('db', stub as unknown as DOStub);
  await next();
});

app.use('/v1/*', rateLimitMiddleware());
app.use('/oauth/*', rateLimitMiddleware());

app.onError((err, c) => {
  console.error(err);

  if (err instanceof ApiError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details && { details: err.details }),
        },
      },
      err.statusCode as any,
    );
  }

  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
});

app.get('/', (c) => c.json({ name: 'merchant', version: VERSION, ok: true }));

app.route('/v1/setup', setup);
app.route('/v1/products', catalog);
app.route('/v1/inventory', inventory);
app.route('/v1/carts', checkout);
app.route('/v1/orders', orders);
app.route('/v1/customers', customers);
app.route('/v1/webhooks', webhooks);
app.route('/v1/webhooks', webhooksRoutes);
app.route('/v1/images', images);
app.route('/v1/discounts', discounts);
app.route('/v1/analytics', analytics);
app.route('/v1/keys', keys);
app.route('/oauth', oauth);
app.route('', oauth);
app.route('', ucp);

app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
});

app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'Merchant API',
    version: VERSION,
    description:
      'The open-source commerce backend for Cloudflare + Stripe. ' +
      'OAuth 2.0 + PKCE endpoints under /oauth. ' +
      'UCP endpoints under /ucp/v1. ' +
      'Stripe webhook receiver at /v1/webhooks/stripe.',
  },
  servers: [{ url: '/' }],
});

app.get('/docs', swaggerUI({ url: '/openapi.json' }));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      const id = env.MERCHANT.idFromName('default');
      const stub = env.MERCHANT.get(id);

      // Extract the API key from the Authorization Bearer header OR the ?key= query param
      // (browsers cannot set custom headers on WebSocket connections, so ?key= is the browser path).
      const url = new URL(request.url);
      const bearerKey = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? null;
      const queryKey = url.searchParams.get('key');
      const rawKey = bearerKey ?? queryKey ?? null;

      // Forward the key to the DO in a controlled internal header.
      // We must overwrite any client-supplied X-WS-Key to prevent spoofing.
      const forwardHeaders = new Headers(request.headers);
      if (rawKey !== null) {
        forwardHeaders.set('X-WS-Key', rawKey);
      } else {
        forwardHeaders.delete('X-WS-Key');
      }

      const forwardRequest = new Request(request.url, {
        method: request.method,
        headers: forwardHeaders,
        body: request.body,
      });

      return stub.fetch(forwardRequest);
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const id = env.MERCHANT.idFromName('default');
    const stub = env.MERCHANT.get(id) as unknown as {
      cleanupExpiredCarts: () => Promise<number>;
      pruneOldData: () => Promise<{
        analyticsEvents: number;
        analyticsSessions: number;
        stripeEvents: number;
        webhookDeliveries: number;
      }>;
    };

    const cleaned = await stub.cleanupExpiredCarts();
    console.log(`Cron: cleaned ${cleaned} expired carts`);

    const pruned = await stub.pruneOldData();
    console.log(
      `Cron: pruned analytics_events=${pruned.analyticsEvents} analytics_sessions=${pruned.analyticsSessions} stripe_events=${pruned.stripeEvents} webhook_deliveries=${pruned.webhookDeliveries}`,
    );

    const retried = await retryFailedDeliveries(stub as unknown as DOStub, ctx);
    console.log(`Cron: queued ${retried} failed webhook deliveries for retry`);
  },
};
