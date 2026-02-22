import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import {
  IdParam,
  ProductResponse,
  ProductImageResponse,
  ProductListResponse,
  CreateProductBody,
  UpdateProductBody,
  ProductQuery,
  VariantResponse,
  CreateVariantBody,
  UpdateVariantBody,
  ErrorResponse,
  DeletedResponse,
} from '../schemas';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const VariantIdParam = z.object({
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
  variantId: z.string().uuid().openapi({ param: { name: 'variantId', in: 'path' } }),
});

const app = new OpenAPIHono<HonoEnv>();

app.use('*', authMiddleware);

const listProducts = createRoute({
  method: 'get',
  path: '/',
  tags: ['Products'],
  summary: 'List products',
  security: [{ bearerAuth: [] }],
  request: { query: ProductQuery },
  responses: {
    200: { content: { 'application/json': { schema: ProductListResponse } }, description: 'List of products' },
  },
});

app.openapi(listProducts, async (c) => {
  const db = getDb(c.var.db);
  const { limit: limitStr, cursor, status } = c.req.valid('query');
  const limit = Math.min(parseInt(limitStr || '20'), 100);

  let query = `SELECT * FROM products`;
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (status) {
    conditions.push(`status = ?`);
    params.push(status);
  }
  if (cursor) {
    conditions.push(`created_at < ?`);
    params.push(cursor);
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit + 1);

  const products = await db.query<any>(query, params);
  const hasMore = products.length > limit;
  if (hasMore) products.pop();

  const productIds = products.map((p) => p.id);
  const variantsByProduct: Record<string, any[]> = {};
  const imagesByProduct: Record<string, any[]> = {};

  if (productIds.length > 0) {
    const placeholders = productIds.map(() => '?').join(',');
    const allVariants = await db.query<any>(
      `SELECT * FROM variants WHERE product_id IN (${placeholders}) ORDER BY created_at ASC`,
      productIds
    );

    for (const v of allVariants) {
      if (!variantsByProduct[v.product_id]) {
        variantsByProduct[v.product_id] = [];
      }
      variantsByProduct[v.product_id].push(v);
    }

    const allImages = await db.query<any>(
      `SELECT * FROM product_images WHERE product_id IN (${placeholders}) ORDER BY position ASC`,
      productIds
    );

    for (const img of allImages) {
      if (!imagesByProduct[img.product_id]) {
        imagesByProduct[img.product_id] = [];
      }
      imagesByProduct[img.product_id].push(img);
    }
  }

  const items = products.map((p) => ({
    id: p.id,
    title: p.title,
    slug: p.slug || slugify(p.title),
    description: p.description,
    image_url: p.image_url || null,
    status: p.status,
    images: (imagesByProduct[p.id] || []).map((img) => ({
      id: img.id,
      image_url: img.image_url,
      position: img.position,
    })),
    created_at: p.created_at,
    variants: (variantsByProduct[p.id] || []).map((v) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      price_cents: v.price_cents,
      image_url: v.image_url,
    })),
  }));

  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].created_at : null;

  return c.json({ items, pagination: { has_more: hasMore, next_cursor: nextCursor } }, 200);
});

const getProduct = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Products'],
  summary: 'Get product by ID',
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { content: { 'application/json': { schema: ProductResponse } }, description: 'Product details' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
  },
});

app.openapi(getProduct, async (c) => {
  const db = getDb(c.var.db);
  const { id } = c.req.valid('param');

  const [product] = await db.query<any>(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!product) throw ApiError.notFound('Product not found');

  const variants = await db.query<any>(
    `SELECT * FROM variants WHERE product_id = ? ORDER BY created_at ASC`,
    [id]
  );

  const images = await db.query<any>(
    `SELECT * FROM product_images WHERE product_id = ? ORDER BY position ASC`,
    [id]
  );

  return c.json({
    id: product.id,
    title: product.title,
    slug: product.slug || slugify(product.title),
    description: product.description,
    image_url: product.image_url || null,
    status: product.status,
    images: images.map((img) => ({
      id: img.id,
      image_url: img.image_url,
      position: img.position,
    })),
    created_at: product.created_at,
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      price_cents: v.price_cents,
      image_url: v.image_url,
    })),
  }, 200);
});

const createProduct = createRoute({
  method: 'post',
  path: '/',
  tags: ['Products'],
  summary: 'Create product',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { body: { content: { 'application/json': { schema: CreateProductBody } } } },
  responses: {
    201: { content: { 'application/json': { schema: ProductResponse } }, description: 'Product created' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid request' },
  },
});

app.openapi(createProduct, async (c) => {
  const { title, slug: requestedSlug, description, image_url } = c.req.valid('json');
  const db = getDb(c.var.db);

  const id = uuid();
  const timestamp = now();

  let slug = requestedSlug || slugify(title);

  // Ensure slug uniqueness
  const [existing] = await db.query<any>(`SELECT id FROM products WHERE slug = ?`, [slug]);
  if (existing) {
    slug = `${slug}-${id.slice(0, 8)}`;
  }

  await db.run(
    `INSERT INTO products (id, title, slug, description, image_url, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    [id, title, slug, description || null, image_url || null, timestamp]
  );

  return c.json(
    { id, title, slug, description: description || null, image_url: image_url || null, status: 'active' as const, images: [], created_at: timestamp, variants: [] },
    201
  );
});

const updateProduct = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Products'],
  summary: 'Update product',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    params: IdParam,
    body: { content: { 'application/json': { schema: UpdateProductBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: ProductResponse } }, description: 'Product updated' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
  },
});

app.openapi(updateProduct, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const db = getDb(c.var.db);

  const [existing] = await db.query<any>(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!existing) throw ApiError.notFound('Product not found');

  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.title !== undefined) {
    updates.push('title = ?');
    params.push(body.title);
  }
  if (body.slug !== undefined) {
    updates.push('slug = ?');
    params.push(body.slug);
  }
  if (body.description !== undefined) {
    updates.push('description = ?');
    params.push(body.description);
  }
  if (body.image_url !== undefined) {
    updates.push('image_url = ?');
    params.push(body.image_url);
  }
  if (body.status !== undefined) {
    updates.push('status = ?');
    params.push(body.status);
  }

  if (updates.length > 0) {
    params.push(id);
    await db.run(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const [product] = await db.query<any>(`SELECT * FROM products WHERE id = ?`, [id]);
  const variants = await db.query<any>(`SELECT * FROM variants WHERE product_id = ?`, [id]);
  const images = await db.query<any>(
    `SELECT * FROM product_images WHERE product_id = ? ORDER BY position ASC`,
    [id]
  );

  return c.json({
    id: product.id,
    title: product.title,
    slug: product.slug || slugify(product.title),
    description: product.description,
    image_url: product.image_url || null,
    status: product.status,
    images: images.map((img) => ({
      id: img.id,
      image_url: img.image_url,
      position: img.position,
    })),
    created_at: product.created_at,
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      price_cents: v.price_cents,
      image_url: v.image_url,
    })),
  }, 200);
});

const deleteProduct = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Products'],
  summary: 'Delete product',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { params: IdParam },
  responses: {
    200: { content: { 'application/json': { schema: DeletedResponse } }, description: 'Product deleted' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cannot delete' },
  },
});

app.openapi(deleteProduct, async (c) => {
  const { id } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [product] = await db.query<any>(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!product) throw ApiError.notFound('Product not found');

  const variants = await db.query<any>(`SELECT sku FROM variants WHERE product_id = ?`, [id]);

  if (variants.length > 0) {
    const skus = variants.map((v) => v.sku);
    const placeholders = skus.map(() => '?').join(',');
    const [orderItem] = await db.query<any>(
      `SELECT id FROM order_items WHERE sku IN (${placeholders}) LIMIT 1`,
      skus
    );

    if (orderItem) {
      throw ApiError.conflict('Cannot delete product with variants that have been ordered. Set status to draft instead.');
    }
  }

  for (const v of variants) {
    await db.run(`DELETE FROM inventory WHERE sku = ?`, [v.sku]);
  }

  await db.run(`DELETE FROM product_images WHERE product_id = ?`, [id]);
  await db.run(`DELETE FROM variants WHERE product_id = ?`, [id]);
  await db.run(`DELETE FROM products WHERE id = ?`, [id]);

  return c.json({ deleted: true as const }, 200);
});

const createVariant = createRoute({
  method: 'post',
  path: '/{id}/variants',
  tags: ['Products'],
  summary: 'Add variant to product',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    params: IdParam,
    body: { content: { 'application/json': { schema: CreateVariantBody } } },
  },
  responses: {
    201: { content: { 'application/json': { schema: VariantResponse } }, description: 'Variant created' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Product not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'SKU already exists' },
  },
});

app.openapi(createVariant, async (c) => {
  const { id: productId } = c.req.valid('param');
  const { sku, title, price_cents, image_url } = c.req.valid('json');
  const db = getDb(c.var.db);

  const [product] = await db.query<any>(`SELECT * FROM products WHERE id = ?`, [productId]);
  if (!product) throw ApiError.notFound('Product not found');

  const [existingSku] = await db.query<any>(`SELECT * FROM variants WHERE sku = ?`, [sku]);
  if (existingSku) throw ApiError.conflict(`SKU ${sku} already exists`);

  const id = uuid();
  const timestamp = now();

  await db.run(
    `INSERT INTO variants (id, product_id, sku, title, price_cents, weight_grams, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, productId, sku, title, price_cents, 0, image_url || null, timestamp]
  );

  await db.run(
    `INSERT INTO inventory (id, sku, on_hand, reserved, updated_at) VALUES (?, ?, 0, 0, ?)`,
    [uuid(), sku, timestamp]
  );

  return c.json({ id, sku, title, price_cents, image_url: image_url || null }, 201);
});

const updateVariant = createRoute({
  method: 'patch',
  path: '/{id}/variants/{variantId}',
  tags: ['Products'],
  summary: 'Update variant',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    params: VariantIdParam,
    body: { content: { 'application/json': { schema: UpdateVariantBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: VariantResponse } }, description: 'Variant updated' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'SKU already exists' },
  },
});

app.openapi(updateVariant, async (c) => {
  const { id: productId, variantId } = c.req.valid('param');
  const body = c.req.valid('json');
  const db = getDb(c.var.db);

  const [existing] = await db.query<any>(
    `SELECT * FROM variants WHERE id = ? AND product_id = ?`,
    [variantId, productId]
  );
  if (!existing) throw ApiError.notFound('Variant not found');

  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.sku !== undefined) {
    const [existingSku] = await db.query<any>(
      `SELECT * FROM variants WHERE sku = ? AND id != ?`,
      [body.sku, variantId]
    );
    if (existingSku) throw ApiError.conflict(`SKU ${body.sku} already exists`);

    await db.run(`UPDATE inventory SET sku = ? WHERE sku = ?`, [body.sku, existing.sku]);
    updates.push('sku = ?');
    params.push(body.sku);
  }
  if (body.title !== undefined) {
    updates.push('title = ?');
    params.push(body.title);
  }
  if (body.price_cents !== undefined) {
    updates.push('price_cents = ?');
    params.push(body.price_cents);
  }
  if (body.image_url !== undefined) {
    updates.push('image_url = ?');
    params.push(body.image_url);
  }

  if (updates.length > 0) {
    params.push(variantId);
    await db.run(`UPDATE variants SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const [variant] = await db.query<any>(`SELECT * FROM variants WHERE id = ?`, [variantId]);

  return c.json({
    id: variant.id,
    sku: variant.sku,
    title: variant.title,
    price_cents: variant.price_cents,
    image_url: variant.image_url,
  }, 200);
});

const deleteVariant = createRoute({
  method: 'delete',
  path: '/{id}/variants/{variantId}',
  tags: ['Products'],
  summary: 'Delete variant',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { params: VariantIdParam },
  responses: {
    200: { content: { 'application/json': { schema: DeletedResponse } }, description: 'Variant deleted' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cannot delete' },
  },
});

app.openapi(deleteVariant, async (c) => {
  const { id: productId, variantId } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [variant] = await db.query<any>(
    `SELECT * FROM variants WHERE id = ? AND product_id = ?`,
    [variantId, productId]
  );
  if (!variant) throw ApiError.notFound('Variant not found');

  const [orderItem] = await db.query<any>(`SELECT id FROM order_items WHERE sku = ? LIMIT 1`, [variant.sku]);
  if (orderItem) {
    throw ApiError.conflict('Cannot delete variant that has been ordered. Set product status to draft instead.');
  }

  await db.run(`DELETE FROM inventory WHERE sku = ?`, [variant.sku]);
  await db.run(`DELETE FROM variants WHERE id = ?`, [variantId]);

  return c.json({ deleted: true as const }, 200);
});

// ============================================================
// PRODUCT IMAGE ROUTES
// ============================================================

const ImageIdParam = z.object({
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
  imageId: z.string().uuid().openapi({ param: { name: 'imageId', in: 'path' } }),
});

const CreateProductImageBody = z.object({
  image_url: z.string().url().openapi({ example: 'https://example.com/image.jpg' }),
  position: z.number().int().min(0).optional().openapi({ example: 0 }),
}).openapi('CreateProductImage');

const addProductImage = createRoute({
  method: 'post',
  path: '/{id}/images',
  tags: ['Products'],
  summary: 'Add image to product',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    params: IdParam,
    body: { content: { 'application/json': { schema: CreateProductImageBody } } },
  },
  responses: {
    201: { content: { 'application/json': { schema: ProductImageResponse } }, description: 'Image added' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Product not found' },
  },
});

app.openapi(addProductImage, async (c) => {
  const { id: productId } = c.req.valid('param');
  const { image_url, position } = c.req.valid('json');
  const db = getDb(c.var.db);

  const [product] = await db.query<any>(`SELECT * FROM products WHERE id = ?`, [productId]);
  if (!product) throw ApiError.notFound('Product not found');

  const id = uuid();
  const timestamp = now();

  // If no position specified, put it at the end
  let pos = position;
  if (pos === undefined) {
    const [maxPos] = await db.query<any>(
      `SELECT COALESCE(MAX(position), -1) as max_pos FROM product_images WHERE product_id = ?`,
      [productId]
    );
    pos = (maxPos?.max_pos ?? -1) + 1;
  }

  await db.run(
    `INSERT INTO product_images (id, product_id, image_url, position, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, productId, image_url, pos, timestamp]
  );

  return c.json({ id, image_url, position: pos as number }, 201);
});

const deleteProductImage = createRoute({
  method: 'delete',
  path: '/{id}/images/{imageId}',
  tags: ['Products'],
  summary: 'Delete product image',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { params: ImageIdParam },
  responses: {
    200: { content: { 'application/json': { schema: DeletedResponse } }, description: 'Image deleted' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
  },
});

app.openapi(deleteProductImage, async (c) => {
  const { id: productId, imageId } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [image] = await db.query<any>(
    `SELECT * FROM product_images WHERE id = ? AND product_id = ?`,
    [imageId, productId]
  );
  if (!image) throw ApiError.notFound('Product image not found');

  await db.run(`DELETE FROM product_images WHERE id = ?`, [imageId]);

  return c.json({ deleted: true as const }, 200);
});

export { app as catalog };
