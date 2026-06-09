/**
 * OpenAPI consistency integration tests.
 *
 * Covers:
 *  (a) Validation error envelope — POST /v1/products with invalid body returns
 *      400 with body.error.code === 'invalid_request' and details.issues array.
 *  (b) bearerAuth security scheme — GET /openapi.json includes
 *      components.securitySchemes.bearerAuth with scheme 'bearer'.
 *  (c) Version consistency — GET / and openapi.json info.version agree.
 */

import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { jsonBody, type SeedResult, seedStore } from './helpers';

let seed: SeedResult;

beforeAll(async () => {
  seed = await seedStore();
});

describe('validation error envelope', () => {
  it('POST /v1/products with missing title returns 400 invalid_request with issues', async () => {
    const res = await SELF.fetch('http://example.com/v1/products', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${seed.sk}`,
      },
      // Missing required `title` field — should trigger zod validation failure
      body: JSON.stringify({ description: 'No title here' }),
    });

    expect(res.status).toBe(400);

    const body = await jsonBody<{
      error: {
        code: string;
        message: string;
        details?: { issues: Array<{ path: string; message: string }> };
      };
    }>(res);

    expect(body.error.code).toBe('invalid_request');
    expect(typeof body.error.message).toBe('string');
    expect(Array.isArray(body.error.details?.issues)).toBe(true);
    expect((body.error.details?.issues?.length ?? 0) > 0).toBe(true);
  });
});

describe('OpenAPI security scheme', () => {
  it('GET /openapi.json has bearerAuth security scheme with scheme bearer', async () => {
    const res = await SELF.fetch('http://example.com/openapi.json');
    expect(res.status).toBe(200);

    const doc = await jsonBody<{
      components?: {
        securitySchemes?: {
          bearerAuth?: { type: string; scheme: string };
        };
      };
    }>(res);

    expect(doc.components?.securitySchemes?.bearerAuth).toBeDefined();
    expect(doc.components?.securitySchemes?.bearerAuth?.type).toBe('http');
    expect(doc.components?.securitySchemes?.bearerAuth?.scheme).toBe('bearer');
  });
});

describe('version consistency', () => {
  it('GET / version and openapi.json info.version agree', async () => {
    const [rootRes, docRes] = await Promise.all([
      SELF.fetch('http://example.com/'),
      SELF.fetch('http://example.com/openapi.json'),
    ]);

    expect(rootRes.status).toBe(200);
    expect(docRes.status).toBe(200);

    const rootBody = await jsonBody<{ version: string }>(rootRes);
    const docBody = await jsonBody<{ info: { version: string } }>(docRes);

    expect(rootBody.version).toBe(docBody.info.version);
  });
});
