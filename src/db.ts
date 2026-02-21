import { type DOStub } from './types';

export type Database = {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
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
