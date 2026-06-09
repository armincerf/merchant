import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { type Database, getDb } from '../db';
import { isBot } from '../lib/bot-detect';
import { adminOnly, authMiddleware } from '../middleware/auth';
import { ErrorResponse } from '../schemas';
import { type HonoEnv, now, uuid } from '../types';

// ============================================================
// SCHEMAS
// ============================================================

const EventType = z
  .enum(['page_view', 'product_view', 'add_to_cart', 'checkout_started', 'order_completed'])
  .openapi({ example: 'page_view' });

const EventData = z
  .object({
    product_id: z.string().optional(),
    product_name: z.string().optional(),
    variant_id: z.string().optional(),
    price_cents: z.number().int().optional(),
    quantity: z.number().int().optional(),
    order_id: z.string().optional(),
    order_total_cents: z.number().int().optional(),
  })
  .passthrough()
  .optional()
  .openapi({ example: { product_id: '550e8400-e29b-41d4-a716-446655440000' } });

const TrackEventBody = z
  .object({
    event_type: EventType,
    session_id: z.string().min(1).openapi({ example: 'sess_abc123' }),
    page_path: z.string().min(1).openapi({ example: '/products/organic-eggs' }),
    referrer: z.string().optional().openapi({ example: 'https://google.com' }),
    event_data: EventData,
  })
  .openapi('TrackEvent');

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
  if (
    /mobile|iphone|ipod|android.*mobile|windows phone|blackberry|opera mini|opera mobi/i.test(ua)
  ) {
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
  description:
    'Record a page view, product view, cart action, or order event. Bot requests are silently dropped. Returns 204 on success.',
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
  const [existingSession] = await db.query<any>(`SELECT id FROM analytics_sessions WHERE id = ?`, [
    session_id,
  ]);

  if (existingSession) {
    await db.run(
      `UPDATE analytics_sessions SET last_seen_at = ?, page_count = page_count + 1 WHERE id = ?`,
      [timestamp, session_id],
    );
  } else {
    await db.run(
      `INSERT INTO analytics_sessions (id, first_seen_at, last_seen_at, page_count, ip_country, device_type) VALUES (?, ?, ?, 1, ?, ?)`,
      [session_id, timestamp, timestamp, ipCountry, deviceType],
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
    ],
  );

  return c.body(null, 204);
});

// ============================================================
// SUMMARY SCHEMAS
// ============================================================

const PeriodQuery = z.object({
  period: z
    .enum(['7d', '30d', '90d'])
    .default('30d')
    .openapi({
      param: { name: 'period', in: 'query' },
      example: '30d',
    }),
});

const TopProduct = z.object({
  product_id: z.string(),
  product_name: z.string(),
  views: z.number().int(),
  add_to_carts: z.number().int(),
  purchases: z.number().int(),
});

const TopPage = z.object({
  page_path: z.string(),
  views: z.number().int(),
});

const TopReferrer = z.object({
  referrer: z.string(),
  count: z.number().int(),
});

const DailyStat = z.object({
  date: z.string(),
  visitors: z.number().int(),
  page_views: z.number().int(),
  orders: z.number().int(),
  revenue_cents: z.number().int(),
});

const DeviceBreakdown = z.object({
  desktop: z.number().int(),
  mobile: z.number().int(),
  tablet: z.number().int(),
});

const PeriodMetrics = z.object({
  visitors: z.number().int(),
  page_views: z.number().int(),
  orders: z.number().int(),
  revenue_cents: z.number().int(),
});

const SummaryResponse = z
  .object({
    visitors: z.number().int(),
    page_views: z.number().int(),
    orders: z.number().int(),
    revenue_cents: z.number().int(),
    top_products: z.array(TopProduct),
    top_pages: z.array(TopPage),
    top_referrers: z.array(TopReferrer),
    daily_stats: z.array(DailyStat),
    prior_period: PeriodMetrics,
    device_breakdown: DeviceBreakdown,
  })
  .openapi('AnalyticsSummary');

// ============================================================
// SUMMARY HELPERS
// ============================================================

function periodToDays(period: '7d' | '30d' | '90d'): number {
  switch (period) {
    case '7d':
      return 7;
    case '30d':
      return 30;
    case '90d':
      return 90;
  }
}

function dateRangeISO(days: number, offsetDays = 0): { start: string; end: string } {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - offsetDays);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

/**
 * Extract the domain from a referrer URL string. Returns the hostname
 * or the raw string if parsing fails.
 */
function extractDomain(referrer: string): string {
  try {
    return new URL(referrer).hostname;
  } catch {
    return referrer;
  }
}

async function queryPeriodMetrics(
  db: Database,
  start: string,
  end: string,
): Promise<{ visitors: number; page_views: number; orders: number; revenue_cents: number }> {
  const [visitors] = await db.query<{ count: number }>(
    `SELECT COUNT(DISTINCT session_id) as count FROM analytics_events WHERE created_at >= ? AND created_at < ?`,
    [start, end],
  );

  const [pageViews] = await db.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'page_view' AND created_at >= ? AND created_at < ?`,
    [start, end],
  );

  const [orders] = await db.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM analytics_events WHERE event_type = 'order_completed' AND created_at >= ? AND created_at < ?`,
    [start, end],
  );

  const [revenue] = await db.query<{ total: number | null }>(
    `SELECT COALESCE(SUM(json_extract(event_data, '$.order_total_cents')), 0) as total FROM analytics_events WHERE event_type = 'order_completed' AND created_at >= ? AND created_at < ?`,
    [start, end],
  );

  return {
    visitors: visitors?.count ?? 0,
    page_views: pageViews?.count ?? 0,
    orders: orders?.count ?? 0,
    revenue_cents: revenue?.total ?? 0,
  };
}

// ============================================================
// SUMMARY ROUTE
// ============================================================

const getSummary = createRoute({
  method: 'get',
  path: '/summary',
  tags: ['Analytics'],
  summary: 'Get analytics summary',
  description:
    'Returns aggregated analytics metrics for the specified period. Admin access required.',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    query: PeriodQuery,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SummaryResponse } },
      description: 'Analytics summary',
    },
    403: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Forbidden' },
  },
});

app.openapi(getSummary, async (c) => {
  const { period } = c.req.valid('query');
  const db = getDb(c.var.db);
  const days = periodToDays(period);

  // Current period range
  const current = dateRangeISO(days, 0);
  // Prior period range (the equivalent window immediately before the current one)
  const prior = dateRangeISO(days, days);

  // --- Core metrics (current + prior) ---
  const [currentMetrics, priorMetrics] = await Promise.all([
    queryPeriodMetrics(db, current.start, current.end),
    queryPeriodMetrics(db, prior.start, prior.end),
  ]);

  // --- Top products ---
  const topProducts = await db.query<{
    product_id: string;
    product_name: string;
    views: number;
    add_to_carts: number;
    purchases: number;
  }>(
    `SELECT
       json_extract(event_data, '$.product_id') as product_id,
       COALESCE(json_extract(event_data, '$.product_name'), json_extract(event_data, '$.product_id')) as product_name,
       SUM(CASE WHEN event_type = 'product_view' THEN 1 ELSE 0 END) as views,
       SUM(CASE WHEN event_type = 'add_to_cart' THEN 1 ELSE 0 END) as add_to_carts,
       SUM(CASE WHEN event_type = 'order_completed' THEN 1 ELSE 0 END) as purchases
     FROM analytics_events
     WHERE json_extract(event_data, '$.product_id') IS NOT NULL
       AND created_at >= ? AND created_at < ?
     GROUP BY json_extract(event_data, '$.product_id')
     ORDER BY views DESC
     LIMIT 10`,
    [current.start, current.end],
  );

  // --- Top pages ---
  const topPages = await db.query<{ page_path: string; views: number }>(
    `SELECT page_path, COUNT(*) as views
     FROM analytics_events
     WHERE event_type = 'page_view'
       AND created_at >= ? AND created_at < ?
     GROUP BY page_path
     ORDER BY views DESC
     LIMIT 10`,
    [current.start, current.end],
  );

  // --- Top referrers (raw, grouped by domain in code) ---
  const referrerRows = await db.query<{ referrer: string; count: number }>(
    `SELECT referrer, COUNT(*) as count
     FROM analytics_events
     WHERE referrer IS NOT NULL AND referrer != ''
       AND created_at >= ? AND created_at < ?
     GROUP BY referrer
     ORDER BY count DESC`,
    [current.start, current.end],
  );

  // Group referrers by domain
  const domainMap = new Map<string, number>();
  for (const row of referrerRows) {
    const domain = extractDomain(row.referrer);
    domainMap.set(domain, (domainMap.get(domain) ?? 0) + row.count);
  }
  const topReferrers = Array.from(domainMap.entries())
    .map(([referrer, count]) => ({ referrer, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // --- Daily stats ---
  const dailyStats = await db.query<{
    date: string;
    visitors: number;
    page_views: number;
    orders: number;
    revenue_cents: number;
  }>(
    `SELECT
       DATE(created_at) as date,
       COUNT(DISTINCT session_id) as visitors,
       SUM(CASE WHEN event_type = 'page_view' THEN 1 ELSE 0 END) as page_views,
       SUM(CASE WHEN event_type = 'order_completed' THEN 1 ELSE 0 END) as orders,
       COALESCE(SUM(CASE WHEN event_type = 'order_completed' THEN json_extract(event_data, '$.order_total_cents') ELSE 0 END), 0) as revenue_cents
     FROM analytics_events
     WHERE created_at >= ? AND created_at < ?
     GROUP BY DATE(created_at)
     ORDER BY date ASC`,
    [current.start, current.end],
  );

  // Fill in missing days with zeroed metrics
  const dailyMap = new Map(dailyStats.map((d) => [d.date, d]));
  const filledDaily: Array<{
    date: string;
    visitors: number;
    page_views: number;
    orders: number;
    revenue_cents: number;
  }> = [];
  const cursor = new Date(current.start);
  const endDate = new Date(current.end);
  while (cursor < endDate) {
    const dateStr = cursor.toISOString().slice(0, 10);
    filledDaily.push(
      dailyMap.get(dateStr) ?? {
        date: dateStr,
        visitors: 0,
        page_views: 0,
        orders: 0,
        revenue_cents: 0,
      },
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // --- Device breakdown ---
  const deviceRows = await db.query<{ device_type: string; count: number }>(
    `SELECT device_type, COUNT(*) as count
     FROM analytics_sessions
     WHERE first_seen_at >= ? AND first_seen_at < ?
     GROUP BY device_type`,
    [current.start, current.end],
  );

  const deviceBreakdown = { desktop: 0, mobile: 0, tablet: 0 };
  for (const row of deviceRows) {
    if (
      row.device_type === 'desktop' ||
      row.device_type === 'mobile' ||
      row.device_type === 'tablet'
    ) {
      deviceBreakdown[row.device_type] = row.count;
    }
  }

  return c.json(
    {
      ...currentMetrics,
      top_products: topProducts.map((p) => ({
        product_id: p.product_id,
        product_name: p.product_name,
        views: p.views,
        add_to_carts: p.add_to_carts,
        purchases: p.purchases,
      })),
      top_pages: topPages.map((p) => ({
        page_path: p.page_path,
        views: p.views,
      })),
      top_referrers: topReferrers,
      daily_stats: filledDaily,
      prior_period: priorMetrics,
      device_breakdown: deviceBreakdown,
    },
    200,
  );
});

// ============================================================
// FUNNEL SCHEMAS
// ============================================================

const FunnelStep = z
  .object({
    name: z.string().openapi({ example: 'Page View' }),
    event_type: z.string().openapi({ example: 'page_view' }),
    unique_sessions: z.number().int().openapi({ example: 1000 }),
    drop_off_pct: z.number().openapi({
      example: 0,
      description: 'Percentage decrease from previous step. First step = 0.',
    }),
  })
  .openapi('FunnelStep');

const FunnelResponse = z
  .object({
    period: z.enum(['7d', '30d', '90d']).openapi({ example: '30d' }),
    steps: z.array(FunnelStep),
  })
  .openapi('ConversionFunnel');

// ============================================================
// FUNNEL ROUTE
// ============================================================

const FUNNEL_STEPS = [
  { name: 'Page View', event_type: 'page_view' },
  { name: 'Product View', event_type: 'product_view' },
  { name: 'Add to Cart', event_type: 'add_to_cart' },
  { name: 'Checkout Started', event_type: 'checkout_started' },
  { name: 'Order Completed', event_type: 'order_completed' },
] as const;

const getFunnel = createRoute({
  method: 'get',
  path: '/funnel',
  tags: ['Analytics'],
  summary: 'Get conversion funnel',
  description:
    'Returns conversion funnel data showing drop-off between each step. Admin access required.',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    query: PeriodQuery,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: FunnelResponse } },
      description: 'Conversion funnel data',
    },
    403: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Forbidden' },
  },
});

app.openapi(getFunnel, async (c) => {
  const { period } = c.req.valid('query');
  const db = getDb(c.var.db);
  const days = periodToDays(period);
  const { start, end } = dateRangeISO(days, 0);

  // For a true funnel, each step only counts sessions that also appeared in all
  // previous steps. We build up a running intersection of session sets.
  let previousSessions: Set<string> | null = null;

  const steps: Array<{
    name: string;
    event_type: string;
    unique_sessions: number;
    drop_off_pct: number;
  }> = [];

  for (const step of FUNNEL_STEPS) {
    // Get distinct sessions for this event type in the period
    const rows = await db.query<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM analytics_events WHERE event_type = ? AND created_at >= ? AND created_at < ?`,
      [step.event_type, start, end],
    );

    const currentSessions = new Set(rows.map((r) => r.session_id));

    // Intersect with previous step's sessions (true funnel)
    let funnelSessions: Set<string>;
    if (previousSessions === null) {
      // First step: no intersection needed
      funnelSessions = currentSessions;
    } else {
      // Only keep sessions that were in the previous step AND this step
      funnelSessions = new Set<string>();
      for (const sid of currentSessions) {
        if (previousSessions.has(sid)) {
          funnelSessions.add(sid);
        }
      }
    }

    const uniqueSessions = funnelSessions.size;
    const previousCount = steps.length > 0 ? steps[steps.length - 1].unique_sessions : 0;

    const dropOffPct =
      steps.length === 0 || previousCount === 0
        ? 0
        : Math.round(((previousCount - uniqueSessions) / previousCount) * 10000) / 100;

    steps.push({
      name: step.name,
      event_type: step.event_type,
      unique_sessions: uniqueSessions,
      drop_off_pct: dropOffPct,
    });

    previousSessions = funnelSessions;
  }

  return c.json({ period, steps }, 200);
});

export { app as analytics };
