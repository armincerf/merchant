import { ApiError } from '../types';

/**
 * Parse a composite cursor of the form `<date>|<id>`.
 * Throws ApiError.invalidRequest if the cursor is malformed.
 */
export function parseCompositeCursor(cursor: string): { date: string; id: string } {
  const parts = cursor.split('|');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw ApiError.invalidRequest('Invalid cursor');
  }
  return { date: parts[0], id: parts[1] };
}
