import { OpenAPIHono } from '@hono/zod-openapi';
import type { HonoEnv } from '../types';

/**
 * Factory that creates an OpenAPIHono instance with a defaultHook that
 * converts Zod validation failures into the standard ApiError envelope:
 *
 *   { error: { code: 'invalid_request', message: '...', details: { issues: [...] } } }
 *
 * All route sub-apps should use this instead of `new OpenAPIHono<HonoEnv>()`.
 */
export function createApp() {
  return new OpenAPIHono<HonoEnv>({
    defaultHook(result, c) {
      if (!result.success) {
        const issues = result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        }));

        const firstMessage = issues[0]?.message ?? 'Validation failed';
        const fieldPath = issues[0]?.path;
        const message = fieldPath ? `${fieldPath}: ${firstMessage}` : firstMessage;

        return c.json(
          {
            error: {
              code: 'invalid_request',
              message,
              details: { issues },
            },
          },
          400,
        );
      }
    },
  });
}
