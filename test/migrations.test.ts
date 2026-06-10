/**
 * Schema migration framework tests.
 *
 * Uses runInDurableObject to drive applyMigrations against real DO SQLite
 * storage in workerd. Each test uses its own DO instance so migration
 * histories don't interfere.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { MerchantDO } from '../src/do';
import { applyMigrations, MIGRATIONS, type Migration } from '../src/migrations';

function getStub(name: string) {
  const e = env as { MERCHANT: DurableObjectNamespace<MerchantDO> };
  return e.MERCHANT.get(e.MERCHANT.idFromName(name));
}

describe('fresh install', () => {
  it('lands on the latest version with the full schema', async () => {
    const stub = getStub('migrations-fresh');
    const result = await runInDurableObject(stub, (instance: MerchantDO) => {
      // Any public DO method triggers ensureInitialized → applyMigrations.
      const tables = instance.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );
      const indexes = instance.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_orders_stripe_session_unique'",
      );
      const history = instance.query<{ version: number; name: string }>(
        'SELECT version, name FROM schema_migrations ORDER BY version',
      );
      return { tables: tables.map((t) => t.name), indexes, history };
    });

    expect(result.history).toEqual(MIGRATIONS.map((m, i) => ({ version: i + 1, name: m.name })));
    for (const table of [
      'products',
      'variants',
      'orders',
      'carts',
      'customers',
      'idempotency_keys',
    ]) {
      expect(result.tables).toContain(table);
    }
    // The partial unique index applies cleanly on a fresh database.
    expect(result.indexes).toHaveLength(1);
  });
});

describe('pre-framework deployment', () => {
  it('adopts the framework without touching existing data', async () => {
    const stub = getStub('migrations-adopt');
    const result = await runInDurableObject(stub, (instance: MerchantDO, state) => {
      // Simulate a deployment that predates the framework: baseline tables
      // exist (created by the old ensureInitialized), data is present, and
      // there is no schema_migrations table.
      MIGRATIONS[0].up(state.storage.sql);
      state.storage.sql.exec(
        "INSERT INTO products (id, title, slug) VALUES ('p1', 'Legacy Widget', 'legacy-widget')",
      );
      const before = state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'")
        .toArray();

      // First request after updating to the new code.
      const products = instance.query<{ id: string; title: string }>(
        'SELECT id, title FROM products',
      );
      const history = instance.query<{ version: number; name: string }>(
        'SELECT version, name FROM schema_migrations ORDER BY version',
      );
      return { hadMigrationsTable: before.length > 0, products, history };
    });

    expect(result.hadMigrationsTable).toBe(false);
    expect(result.products).toEqual([{ id: 'p1', title: 'Legacy Widget' }]);
    expect(result.history).toEqual(MIGRATIONS.map((m, i) => ({ version: i + 1, name: m.name })));
  });
});

describe('applyMigrations', () => {
  const v1: Migration = {
    name: '001-create-widgets',
    up(sql) {
      sql.exec('CREATE TABLE widgets (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    },
  };
  const v2AddColumn: Migration = {
    name: '002-add-widgets-color',
    up(sql) {
      sql.exec("ALTER TABLE widgets ADD COLUMN color TEXT NOT NULL DEFAULT 'red'");
    },
  };

  it('upgrades version N to N+1, preserving existing data', async () => {
    const stub = getStub('migrations-upgrade');
    const result = await runInDurableObject(stub, (_instance, state) => {
      // Deploy at version 1 and write data.
      const first = applyMigrations(state.storage, [v1]);
      state.storage.sql.exec("INSERT INTO widgets (id, title) VALUES ('w1', 'Gadget')");

      // Deploy at version 2 (adds a column).
      const second = applyMigrations(state.storage, [v1, v2AddColumn]);

      // Existing row survives with the column default; the column is usable.
      state.storage.sql.exec(
        "INSERT INTO widgets (id, title, color) VALUES ('w2', 'Gizmo', 'blue')",
      );
      const rows = state.storage.sql
        .exec('SELECT id, title, color FROM widgets ORDER BY id')
        .toArray();

      // Re-running at the same version is a no-op.
      const third = applyMigrations(state.storage, [v1, v2AddColumn]);
      return { first, second, third, rows };
    });

    expect(result.first).toBe(1);
    expect(result.second).toBe(1);
    expect(result.third).toBe(0);
    expect(result.rows).toEqual([
      { id: 'w1', title: 'Gadget', color: 'red' },
      { id: 'w2', title: 'Gizmo', color: 'blue' },
    ]);
  });

  it('rolls back a failed migration and retries it on the next run', async () => {
    const stub = getStub('migrations-rollback');
    const result = await runInDurableObject(stub, (_instance, state) => {
      const broken: Migration = {
        name: '002-broken',
        up(sql) {
          sql.exec('CREATE TABLE half_done (id TEXT PRIMARY KEY)');
          throw new Error('migration exploded');
        },
      };
      let error: string | null = null;
      try {
        applyMigrations(state.storage, [v1, broken]);
      } catch (err) {
        error = (err as Error).message;
      }
      const halfDone = state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name = 'half_done'")
        .toArray();
      const historyAfterFailure = state.storage.sql
        .exec('SELECT version, name FROM schema_migrations ORDER BY version')
        .toArray();

      // Ship a fixed version of migration 2; it picks up from version 1.
      const fixed: Migration = {
        name: '002-broken',
        up(sql) {
          sql.exec('CREATE TABLE half_done (id TEXT PRIMARY KEY)');
        },
      };
      const retried = applyMigrations(state.storage, [v1, fixed]);
      return { error, halfDone, historyAfterFailure, retried };
    });

    expect(result.error).toBe('migration exploded');
    // The transaction rolled back: no table, no bookkeeping row.
    expect(result.halfDone).toHaveLength(0);
    expect(result.historyAfterFailure).toEqual([{ version: 1, name: '001-create-widgets' }]);
    expect(result.retried).toBe(1);
  });

  it('fails loudly when a recorded migration was edited or reordered', async () => {
    const stub = getStub('migrations-mismatch');
    const result = await runInDurableObject(stub, (_instance, state) => {
      applyMigrations(state.storage, [v1]);
      const renamed: Migration = { name: '001-create-gadgets', up: v1.up };
      try {
        applyMigrations(state.storage, [renamed]);
        return { error: null };
      } catch (err) {
        return { error: (err as Error).message };
      }
    });

    expect(result.error).toContain('Migration history mismatch at version 1');
    expect(result.error).toContain('001-create-widgets');
    expect(result.error).toContain('001-create-gadgets');
  });

  it('tolerates a database that is ahead of the code (rollback)', async () => {
    const stub = getStub('migrations-rollback-deploy');
    const result = await runInDurableObject(stub, (_instance, state) => {
      applyMigrations(state.storage, [v1, v2AddColumn]);
      // Old code that only knows migration 1 starts up against the newer DB.
      const applied = applyMigrations(state.storage, [v1]);
      const rows = state.storage.sql
        .exec('SELECT version FROM schema_migrations ORDER BY version')
        .toArray();
      return { applied, rows };
    });

    expect(result.applied).toBe(0);
    expect(result.rows).toEqual([{ version: 1 }, { version: 2 }]);
  });
});
