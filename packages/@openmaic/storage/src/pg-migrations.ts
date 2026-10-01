/**
 * Versioned schema migrations for the PostgreSQL backends.
 *
 * Every backend (a *store*: documents, runtime, assets, ...) declares an
 * ordered list of migrations, numbered from 1. Version 1 is the baseline: the
 * idempotent DDL the store ran on every start before migrations were
 * versioned, so it is safe on a fresh database and on any database an earlier
 * release created. Everything after it runs exactly once per database.
 *
 * What ran is recorded in `openmaic_schema_migrations`, one row per store and
 * version, with a checksum of the migration as it ran. On every start
 * {@link applySchemaMigrations}:
 *
 * - refuses to continue when the database records a version of the store newer
 *   than the running code knows ({@link SchemaVersionAheadError}): the database
 *   was upgraded by a newer release, and this one would read and write a schema
 *   it does not understand;
 * - compares the checksums of applied migrations with the code's, and fails
 *   (development and test) or warns (`NODE_ENV=production`) on a difference;
 * - applies the pending migrations in order, each in its own transaction unless
 *   the migration opts out, recording it in the same transaction.
 *
 * Runs are serialized across sessions by an advisory lock held for the whole
 * run, so two instances starting together apply each migration once. A host
 * that provisions several stores in one sequence may still hold a lock of its
 * own around all of them; the two do not conflict.
 *
 * ## Adding a migration
 *
 * Append `{ version: <last + 1>, name, up }` to the store's list. Never edit or
 * remove a migration that has shipped: its checksum is recorded on every
 * database it ran on. A migration that cannot run inside a transaction (for
 * example `CREATE INDEX CONCURRENTLY`) sets `transaction: false` and must then
 * be idempotent on its own, because a failure part-way leaves it unrecorded and
 * it runs again on the next start.
 */

/** The query surface the runner needs: one statement per call, like PGlite. */
export interface MigrationQueryable {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: TRow[] }>;
}

export interface SchemaMigration {
  /** 1 for the baseline, then consecutive integers. */
  readonly version: number;
  /** A short, stable label, recorded with the version. */
  readonly name: string;
  /**
   * SQL, split into statements with {@link splitSqlStatements} and run in
   * order; or a function for work SQL cannot express on its own. The checksum
   * of a function migration covers its version and name only.
   */
  readonly up: string | ((queryable: MigrationQueryable) => Promise<void>);
  /** Run inside one transaction with its record. Defaults to `true`. */
  readonly transaction?: boolean;
}

export interface SchemaMigrationSet {
  /** The key the store's versions are recorded under. */
  readonly store: string;
  readonly migrations: readonly SchemaMigration[];
}

export interface ApplySchemaMigrationsOptions {
  /**
   * Rewrites each SQL migration before it is split and run, for a store whose
   * table names a host overrides. Checksums are taken of the SQL as declared,
   * so a rewrite does not change them.
   */
  rewriteSql?: (sql: string) => string;
}

/** The database records a version of a store newer than the running code knows. */
export class SchemaVersionAheadError extends Error {
  constructor(
    readonly store: string,
    readonly recordedVersion: number,
    readonly knownVersion: number,
  ) {
    super(
      `@openmaic/storage: the database records schema version ${recordedVersion} of ` +
        `${JSON.stringify(store)}, but this release knows versions up to ${knownVersion}. ` +
        'It was upgraded by a newer release; refusing to start rather than run against a ' +
        'schema this release does not understand. Run a release at least as new as the one ' +
        'that upgraded the database.',
    );
    this.name = 'SchemaVersionAheadError';
  }
}

/** An applied migration's recorded checksum differs from the running code's. */
export class SchemaMigrationChecksumError extends Error {
  constructor(
    readonly store: string,
    readonly version: number,
    readonly recordedChecksum: string,
    readonly checksum: string,
  ) {
    super(
      `@openmaic/storage: schema migration ${version} of ${JSON.stringify(store)} was ` +
        `applied with checksum ${recordedChecksum}, but this release declares ` +
        `${checksum}. An applied migration was edited; add a new migration instead.`,
    );
    this.name = 'SchemaMigrationChecksumError';
  }
}

/** The table the runner records applied migrations in. */
export const SCHEMA_MIGRATIONS_TABLE = 'openmaic_schema_migrations';

const SCHEMA_MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
  store TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store, version)
)`;

/**
 * Advisory-lock key serializing migration runs across sessions. Any fixed
 * value distinct from the other keys a deployment takes works.
 */
export const SCHEMA_MIGRATION_LOCK_KEY = 71_310_525;

interface RecordedMigrationRow extends Record<string, unknown> {
  version: number | string;
  checksum: string;
}

interface PoolLike extends MigrationQueryable {
  connect(): Promise<MigrationQueryable & { release(): void }>;
}

/**
 * A pool hands each query to any of its connections, which would split a
 * transaction across sessions; the runner checks one out instead. A checked-out
 * client has `release`, a pool does not.
 */
function isPool(queryable: MigrationQueryable): queryable is PoolLike {
  const candidate = queryable as Partial<PoolLike> & { release?: unknown };
  return typeof candidate.connect === 'function' && typeof candidate.release !== 'function';
}

function assertWellFormed(set: SchemaMigrationSet): void {
  if (typeof set.store !== 'string' || set.store === '') {
    throw new Error('@openmaic/storage: a schema migration set needs a store name');
  }
  set.migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `@openmaic/storage: schema migrations of ${JSON.stringify(set.store)} must be ` +
          `numbered 1, 2, 3, ... in order; position ${index + 1} has version ` +
          `${String(migration.version)}`,
      );
    }
    if (typeof migration.name !== 'string' || migration.name === '') {
      throw new Error(
        `@openmaic/storage: schema migration ${migration.version} of ` +
          `${JSON.stringify(set.store)} needs a name`,
      );
    }
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The checksum recorded for `migration`: of its SQL as declared, or of its identity. */
export function schemaMigrationChecksum(migration: SchemaMigration): Promise<string> {
  return sha256Hex(
    typeof migration.up === 'string'
      ? migration.up.trim()
      : `function:${migration.version}:${migration.name}`,
  );
}

/**
 * A changed checksum fails a development or test start and only warns in
 * production. The migration has already run on that database and is never
 * run again, so refusing to start would take a deployment down without
 * changing its schema; the edit is a mistake to catch before release, which is
 * where development and CI fail on it.
 */
function reportChecksumMismatch(error: SchemaMigrationChecksumError): void {
  const production = typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
  if (!production) throw error;
  console.warn(`${error.message} Continuing because NODE_ENV=production.`);
}

async function runMigration(
  queryable: MigrationQueryable,
  store: string,
  migration: SchemaMigration,
  checksum: string,
  rewriteSql: (sql: string) => string,
): Promise<void> {
  const body = async (): Promise<void> => {
    if (typeof migration.up === 'string') {
      for (const statement of splitSqlStatements(rewriteSql(migration.up))) {
        await queryable.query(statement);
      }
    } else {
      await migration.up(queryable);
    }
    await queryable.query(
      `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (store, version, name, checksum)
       VALUES ($1, $2, $3, $4)`,
      [store, migration.version, migration.name, checksum],
    );
  };
  try {
    if (migration.transaction === false) {
      await body();
      return;
    }
    await queryable.query('BEGIN');
    try {
      await body();
      await queryable.query('COMMIT');
    } catch (error) {
      await queryable.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `@openmaic/storage: schema migration ${migration.version} (${migration.name}) of ` +
        `${JSON.stringify(store)} failed: ${detail}`,
      { cause: error },
    );
  }
}

/**
 * Bring one store's schema up to the newest version this code knows, and
 * answer the versions this call applied.
 *
 * `queryable` is a pool (one connection is checked out for the run), a
 * checked-out client, or a single-connection driver such as PGlite, and must
 * not be inside a transaction.
 */
export async function applySchemaMigrations(
  queryable: MigrationQueryable,
  set: SchemaMigrationSet,
  options: ApplySchemaMigrationsOptions = {},
): Promise<number[]> {
  assertWellFormed(set);
  const rewriteSql = options.rewriteSql ?? ((sql: string) => sql);
  const checksums = await Promise.all(set.migrations.map(schemaMigrationChecksum));
  const client = isPool(queryable) ? await queryable.connect() : undefined;
  const session = client ?? queryable;
  try {
    await session.query('SELECT pg_advisory_lock($1::bigint)', [SCHEMA_MIGRATION_LOCK_KEY]);
    try {
      await session.query(SCHEMA_MIGRATIONS_TABLE_SQL);
      const recorded = await session.query<RecordedMigrationRow>(
        `SELECT version, checksum FROM ${SCHEMA_MIGRATIONS_TABLE}
          WHERE store = $1 ORDER BY version`,
        [set.store],
      );
      const applied = new Map(recorded.rows.map((row) => [Number(row.version), row.checksum]));
      const newest = Math.max(0, ...applied.keys());
      if (newest > set.migrations.length) {
        throw new SchemaVersionAheadError(set.store, newest, set.migrations.length);
      }
      for (const [version, recordedChecksum] of applied) {
        const checksum = checksums[version - 1]!;
        if (recordedChecksum !== checksum) {
          reportChecksumMismatch(
            new SchemaMigrationChecksumError(set.store, version, recordedChecksum, checksum),
          );
        }
      }
      const appliedNow: number[] = [];
      for (const migration of set.migrations) {
        if (applied.has(migration.version)) continue;
        await runMigration(
          session,
          set.store,
          migration,
          checksums[migration.version - 1]!,
          rewriteSql,
        );
        appliedNow.push(migration.version);
      }
      return appliedNow;
    } finally {
      await session.query('SELECT pg_advisory_unlock($1::bigint)', [SCHEMA_MIGRATION_LOCK_KEY]);
    }
  } finally {
    client?.release();
  }
}

/**
 * Split a DDL string into individual statements. A plain `split(';')` would
 * carve the `BEGIN ... END;` blocks inside the dollar-quoted plpgsql trigger
 * bodies into bogus statements, so the splitter skips over single-quoted
 * strings, double-quoted identifiers, `$$...$$` / `$tag$...$tag$` bodies, and
 * `--` line comments and slash-star block comments.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const end = sql.length;
  while (i < end) {
    const rest = sql.slice(i);
    const ch = sql[i];
    if (ch === ';') {
      statements.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (ch === '-' && rest.startsWith('--')) {
      const newline = rest.indexOf('\n');
      const lineEnd = newline === -1 ? end : i + newline + 1;
      current += sql.slice(i, lineEnd);
      i = lineEnd;
      continue;
    }
    if (ch === '/' && rest.startsWith('/*')) {
      const close = rest.indexOf('*/', 2);
      const blockEnd = close === -1 ? end : i + close + 2;
      current += sql.slice(i, blockEnd);
      i = blockEnd;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // Single-quoted string literal or double-quoted identifier; the quote
      // is escaped by doubling, and an unterminated run consumes the rest.
      current += ch;
      i += 1;
      while (i < end) {
        current += sql[i];
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(rest)?.[0];
      if (tag) {
        const close = rest.indexOf(tag, tag.length);
        if (close !== -1) {
          current += rest.slice(0, close + tag.length);
          i += close + tag.length;
          continue;
        }
      }
    }
    current += ch;
    i += 1;
  }
  // The last statement needs no terminating semicolon.
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement !== '');
}
