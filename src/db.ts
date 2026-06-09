import { type DOStub } from './types';

/**
 * Typed wrapper around the DO stub's raw SQL interface.
 * Use this for single-statement ad-hoc queries that don't belong in a DO domain method.
 * Multi-step mutations (anything that needs a transaction) belong in MerchantDO methods instead.
 */
export type Database = {
  /** Execute a SELECT (or any statement returning rows). Generic single-statement SQL escape hatch. */
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
  /** Execute a mutating statement (INSERT/UPDATE/DELETE). Returns the number of affected rows. */
  run: (sql: string, params?: unknown[]) => Promise<{ changes: number }>;
};

export function getDb(stub: DOStub): Database {
  return {
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
      return stub.query<T>(sql, params);
    },

    async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
      return stub.run(sql, params);
    },
  };
}
