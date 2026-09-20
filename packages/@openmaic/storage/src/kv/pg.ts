/**
 * PostgreSQL KV backend over the same injected query surface as the document
 * and runtime backends. The module deliberately imports no PostgreSQL driver:
 * node-postgres, PGlite, and host adapters all supply the small `Queryable`
 * surface.
 *
 * This backend serves the `account` scope and nothing else. `device` values are
 * machine-local by definition — a server-side partition is the one place they
 * must never reach — so every method fails closed on a `device` scope rather
 * than quietly widening it into `account`. The composite `HttpKVStore` is what
 * routes `device` to a local backend; this store is only ever the far end of
 * its `account` half.
 *
 * Entries are partitioned by owner: `(owner_id, key)` is the primary key, and
 * every statement is keyed on the owner, so one account's values are not
 * reachable from another's even when both use the same key.
 *
 * `withTransaction` must check out a fresh connection and open a transaction
 * for every call, pin every query in `body` to it, then commit or roll back and
 * release it. READ COMMITTED isolation is assumed.
 */
import type { Queryable } from '../runtime/pg.js';
import { encodeJson } from '../pg-json.js';
import { assertKVScope, KVScopeViolationError, type KVScope } from './types.js';

export type { QueryResult, Queryable } from '../runtime/pg.js';

export interface PgKVStoreOptions {
  /**
   * On every call, checks out a fresh connection, opens a transaction, pins
   * every query in `body` to it, then commits or rolls back and releases it.
   */
  withTransaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Idempotent schema for the PostgreSQL KV backend. */
const KV_PG_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv_entries (
    owner_id TEXT NOT NULL,
    key      TEXT NOT NULL,
    value    JSONB NOT NULL,
    PRIMARY KEY (owner_id, key)
  )`,
] as const;

/** Provision the KV table. Safe to call on every boot. */
export async function ensureKVSchema(tx: Queryable): Promise<void> {
  for (const statement of KV_PG_SCHEMA) await tx.query(statement);
}

/**
 * Refuse any scope but `account`, before a statement is built.
 *
 * `assertKVScope` first, so an unrecognized scope fails as an unknown scope
 * rather than being reported as a device leak. The message names the boundary
 * that was crossed because that is the invariant a reader needs: a `device`
 * value reaching this store means it left the machine that owns it.
 */
function assertAccountOnly(scope: KVScope): void {
  if (assertKVScope(scope) !== 'account') {
    throw new KVScopeViolationError(
      '@openmaic/storage: device scope crossed the network boundary: ' +
        "the server KV store serves 'account' only",
    );
  }
}

interface ValueRow<T> extends Record<string, unknown> {
  value: T;
}

interface KeyRow extends Record<string, unknown> {
  key: string;
}

/** Owner-partitioned, account-only KV backend on PostgreSQL. */
export class PgKVStore {
  readonly #withTransaction: PgKVStoreOptions['withTransaction'];

  constructor(options: PgKVStoreOptions) {
    this.#withTransaction = options.withTransaction;
  }

  async get<T>(owner: string, key: string, scope: KVScope = 'account'): Promise<T | null> {
    assertAccountOnly(scope);
    return this.#withTransaction(async (tx) => {
      const result = await tx.query<ValueRow<T>>(
        'SELECT value FROM kv_entries WHERE owner_id = $1 AND key = $2',
        [owner, key],
      );
      const row = result.rows[0];
      return row === undefined ? null : row.value;
    });
  }

  async set<T>(owner: string, key: string, value: T, scope: KVScope = 'account'): Promise<void> {
    assertAccountOnly(scope);
    await this.#withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO kv_entries (owner_id, key, value) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [owner, key, encodeJson(value, `KV value for key ${JSON.stringify(key)}`)],
      );
    });
  }

  async remove(owner: string, key: string, scope: KVScope = 'account'): Promise<void> {
    assertAccountOnly(scope);
    await this.#withTransaction(async (tx) => {
      await tx.query('DELETE FROM kv_entries WHERE owner_id = $1 AND key = $2', [owner, key]);
    });
  }

  async keys(owner: string, prefix = '', scope: KVScope = 'account'): Promise<string[]> {
    assertAccountOnly(scope);
    return this.#withTransaction(async (tx) => {
      const result = await tx.query<KeyRow>(
        // The prefix is matched with LIKE, so its own `%` / `_` / `\` are
        // escaped: a caller's literal prefix must never act as a pattern.
        `SELECT key FROM kv_entries
          WHERE owner_id = $1 AND key LIKE $2 ESCAPE '\\'
          ORDER BY key`,
        [owner, `${escapeLikePrefix(prefix)}%`],
      );
      return result.rows.map((row) => row.key);
    });
  }
}

/** Neutralize LIKE metacharacters so a prefix matches itself literally. */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (character) => `\\${character}`);
}
