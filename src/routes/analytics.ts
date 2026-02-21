import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';
import { uuid, now, type HonoEnv } from '../types';
import { isBot } from '../lib/bot-detect';

// ============================================================
// SCHEMAS
// ============================================================

const EventType = z.enum([
  'page_view',
  'product_view',
  'add_to_cart',
  'checkout_started',
  'order_completed',
]).openapi({ example: 'page_view' });

const EventData = z.object({
  product_id: z.string().optional(),
  product_name: z.string().optional(),
  variant_id: z.string().optional(),
  price_cents: z.number().int().optional(),
  quantity: z.number().int().optional(),
  order_id: z.string().optional(),
  order_total_cents: z.number().int().optional(),
}).passthrough().optional().openapi({ example: { product_id: '550e8400-e29b-41d4-a716-446655440000' } });

const TrackEventBody = z.object({
  event_type: EventType,
  session_id: z.string().min(1).openapi({ example: 'sess_abc123' }),
  page_path: z.string().min(1).openapi({ example: '/products/organic-eggs' }),
  referrer: z.string().optional().openapi({ example: 'https://google.com' }),
  event_data: EventData,
}).openapi('TrackEvent');

// ============================================================
// HELPERS
// ============================================================

/**
 * Simple device type classification from User-Agent string.
 * Returns 'mobile', 'tablet', or 'desktop'.
 */
function parseDeviceType(userAgent: string | undefined | null): 'mobile' | 'tablet' | 'desktop' {
  if (!userAgent) return 'desktop';

  const ua = userAgent.toLowerCase();

  // Check tablet first (tablets often also match mobile patterns)
  if (/ipad|tablet|playbook|silk|kindle|android(?!.*mobile)/i.test(ua)) {
    return 'tablet';
  }

  // Check mobile
  if (/mobile|iphone|ipod|android.*mobile|windows phone|blackberry|opera mini|opera mobi/i.test(ua)) {
    return 'mobile';
  }

  return 'desktop';
}

// ============================================================
// ROUTES
// ============================================================

const app = new OpenAPIHono<HonoEnv>();

// Auth required - but pk_ (public) keys are sufficient
app.use('*', authMiddleware);

const trackEvent = createRoute({
  method: 'post',
  path: '/events',
  tags: ['Analytics'],
  summary: 'Track an analytics event',
  description: 'Record a page view, product view, cart action, or order event. Bot requests are silently dropped. Returns 204 on success.',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: TrackEventBody } } },
  },
  responses: {
    204: { description: 'Event accepted' },
  },
});

app.openapi(trackEvent, async (c) => {
  const { event_type, session_id, page_path, referrer, event_data } = c.req.valid('json');

  // Extract request metadata
  const userAgent = c.req.header('User-Agent');
  const ipCountry = c.req.header('CF-IPCountry') || null;

  // Silently drop bot requests
  if (isBot(userAgent)) {
    return c.body(null, 204);
  }

  const db = getDb(c.var.db);
  const timestamp = now();
  const deviceType = parseDeviceType(userAgent);

  // Upsert session: create if not exists, update last_seen_at and page_count
  const [existingSession] = await db.query<any>(
    `SELECT id FROM analytics_sessions WHERE id = ?`,
    [session_id]
  );

  if (existingSession) {
    await db.run(
      `UPDATE analytics_sessions SET last_seen_at = ?, page_count = page_count + 1 WHERE id = ?`,
      [timestamp, session_id]
    );
  } else {
    await db.run(
      `INSERT INTO analytics_sessions (id, first_seen_at, last_seen_at, page_count, ip_country, device_type) VALUES (?, ?, ?, 1, ?, ?)`,
      [session_id, timestamp, timestamp, ipCountry, deviceType]
    );
  }

  // Insert the event
  await db.run(
    `INSERT INTO analytics_events (id, session_id, event_type, event_data, page_path, referrer, user_agent, ip_country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid(),
      session_id,
      event_type,
      event_data ? JSON.stringify(event_data) : null,
      page_path,
      referrer || null,
      userAgent || null,
      ipCountry,
      timestamp,
    ]
  );

  return c.body(null, 204);
});

export { app as analytics };
