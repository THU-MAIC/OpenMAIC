/**
 * Versioned schema migrations for the PostgreSQL backends.
 *
 * Every backend (a *store*: documents, runtime, assets, ...) declares an
 * ordered list of migrations, numbered from 1. Version 1 is the baseline: the
 * idempotent DDL the store ran on every start before migrations were
 * versioned, so it is safe on a fresh database and on any database an earlier
 * release created. Everything after it runs exactly once per database.
 * Baselines run with `transaction: false`: their statements are idempotent one
 * by one, and running them one by one keeps the locks they take as short as
 * the pre-versioned bootstrap kept them (an `ALTER TABLE ... ADD COLUMN IF NOT
 * EXISTS` takes ACCESS EXCLUSIVE even when the column exists, and inside one
 * transaction it would hold it until the whole baseline committed).
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
 *   the migration opts out, recording it in the same transaction (or, for one
 *   that opts out, after its last statement succeeded).
 *
 * Runs are serialized across sessions by a session-level advisory lock held
 * for the whole run, waited on for a bounded time, so two instances starting
 * together apply each migration once. A host that provisions several stores in
 * one sequence may still hold a lock of its own around all of them; the two do
 * not conflict. Session-level locks and multi-statement transactions need a
 * direct or session-pooled connection: a pooler in transaction mode (PgBouncer
 * `pool_mode = transaction`) is not supported.
 *
 * {@link verifySchemaMigrations} is the read-only half: it checks recorded
 * versions and checksums without creating or changing anything, for a host
 * that wants to refuse a database at startup before its lazy stores run.
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
  /**
   * Run inside one transaction with its record. Defaults to `true`. `false`
   * runs each statement on its own, as the pre-versioned bootstrap did, and
   * records the migration after the last one succeeded; every statement must
   * then be idempotent, because a failure part-way leaves the migration
   * unrecorded and it runs again from the start.
   */
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
  /**
   * How long to wait for another session's run to release the migration lock
   * before failing with {@link SchemaLockTimeoutError}. Defaults to
   * {@link DEFAULT_SCHEMA_LOCK_TIMEOUT_MS}.
   */
  lockTimeoutMs?: number;
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

/** A session-level advisory lock was not granted within its wait budget. */
export class SchemaLockTimeoutError extends Error {
  constructor(
    readonly lockName: string,
    readonly lockKey: number,
    readonly timeoutMs: number,
  ) {
    super(
      `@openmaic/storage: timed out after ${timeoutMs} ms waiting for the ${lockName} ` +
        `(pg_advisory_lock ${lockKey}); another session holds it, most likely another ` +
        'instance applying schema changes. Retry once it finishes.',
    );
    this.name = 'SchemaLockTimeoutError';
  }
}

/**
 * Raised when a migration run is asked to start on a connection that is inside
 * a transaction. The runner opens and commits transactions of its own, which
 * would commit or roll back the caller's work with them.
 */
export class SchemaMigrationInTransactionError extends Error {
  constructor(readonly store: string) {
    super(
      `@openmaic/storage: schema migrations of ${JSON.stringify(store)} were asked to run on a ` +
        'connection inside an open transaction. They manage their own transactions, so they ' +
        "would commit or roll back the caller's work; run them on a connection outside a " +
        'transaction.',
    );
    this.name = 'SchemaMigrationInTransactionError';
  }
}

/** The default wait for a schema advisory lock: five minutes. */
export const DEFAULT_SCHEMA_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

const LOCK_POLL_MS = 100;

/**
 * Take a session-level advisory lock on `session`, polling with
 * `pg_try_advisory_lock` until it is granted or `timeoutMs` passes. Bounded so
 * a stuck holder fails a start with a clear error instead of hanging it.
 */
export async function acquireSessionAdvisoryLock(
  session: MigrationQueryable,
  key: number,
  { name, timeoutMs = DEFAULT_SCHEMA_LOCK_TIMEOUT_MS }: { name: string; timeoutMs?: number },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await session.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [key],
    );
    if (result.rows[0]?.locked === true) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SchemaLockTimeoutError(name, key, timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, Math.min(LOCK_POLL_MS, remaining)));
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
 * transaction (and a session lock) across sessions, so the runner checks one
 * connection out instead. Told apart from a single connection by shape:
 *
 * - a client checked out of a pool has `release`;
 * - a node-postgres `Client` has `connect` too (to open itself), but carries
 *   `processID`, which a pool does not;
 * - PGlite has no `connect` at all.
 *
 * Anything else with `connect` and neither of those is used as a pool.
 */
function isPool(queryable: MigrationQueryable): queryable is PoolLike {
  const candidate = queryable as Partial<PoolLike> & { release?: unknown };
  return (
    typeof candidate.connect === 'function' &&
    typeof candidate.release !== 'function' &&
    !('processID' in candidate)
  );
}

/**
 * Whether `session` is inside an open transaction: a transaction-local setting
 * made by one statement is still visible to the next only inside one (outside,
 * each statement is its own transaction). Asked with two plain reads, so a
 * server's log sees nothing from it; the setting is cleared again when found.
 * Timestamp comparisons (`now()` against `statement_timestamp()`) are not used
 * because a single-user engine such as PGlite does not keep them apart.
 */
async function isInsideTransaction(session: MigrationQueryable): Promise<boolean> {
  await session.query(`SELECT set_config('openmaic.schema_migration_probe', 'on', true)`);
  const result = await session.query<{ inside: boolean }>(
    `SELECT current_setting('openmaic.schema_migration_probe', true) = 'on' AS inside`,
  );
  if (result.rows[0]?.inside !== true) return false;
  await session.query(`SELECT set_config('openmaic.schema_migration_probe', '', true)`);
  return true;
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

async function readRecorded(
  session: MigrationQueryable,
  stores: readonly string[],
): Promise<Map<string, Map<number, string>>> {
  const recorded = await session.query<RecordedMigrationRow & { store: string }>(
    `SELECT store, version, checksum FROM ${SCHEMA_MIGRATIONS_TABLE}
      WHERE store = ANY($1::text[]) ORDER BY store, version`,
    [stores],
  );
  const byStore = new Map<string, Map<number, string>>();
  for (const row of recorded.rows) {
    let versions = byStore.get(row.store);
    if (!versions) byStore.set(row.store, (versions = new Map()));
    versions.set(Number(row.version), row.checksum);
  }
  return byStore;
}

/** Refuse a newer recorded version; report an edited applied migration. */
function checkRecorded(
  set: SchemaMigrationSet,
  applied: ReadonlyMap<number, string>,
  checksums: readonly string[],
): void {
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
}

/**
 * Bring one store's schema up to the newest version this code knows, and
 * answer the versions this call applied.
 *
 * `queryable` is a pool (one connection is checked out for the run), a
 * checked-out pool client, a connected node-postgres `Client`, or a
 * single-connection driver such as PGlite. It must not be inside a
 * transaction: that is refused with {@link SchemaMigrationInTransactionError}.
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
    if (await isInsideTransaction(session)) throw new SchemaMigrationInTransactionError(set.store);
    await acquireSessionAdvisoryLock(session, SCHEMA_MIGRATION_LOCK_KEY, {
      name: 'schema migration lock',
      ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }),
    });
    try {
      await session.query(SCHEMA_MIGRATIONS_TABLE_SQL);
      const applied = (await readRecorded(session, [set.store])).get(set.store) ?? new Map();
      checkRecorded(set, applied, checksums);
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
 * Check, without creating or changing anything, that the database records no
 * version of these stores newer than the code knows and that every applied
 * migration still has its recorded checksum. Throws what
 * {@link applySchemaMigrations} would throw for the same records; a database
 * with no record table (nothing applied yet) passes. Takes no lock: it only
 * reads, and a run that is applying migrations meanwhile only adds versions
 * this code knows.
 */
export async function verifySchemaMigrations(
  queryable: MigrationQueryable,
  sets: readonly SchemaMigrationSet[],
): Promise<void> {
  sets.forEach(assertWellFormed);
  const present = await queryable.query<{ present: boolean }>(
    `SELECT to_regclass('${SCHEMA_MIGRATIONS_TABLE}') IS NOT NULL AS present`,
  );
  if (present.rows[0]?.present !== true) return;
  const recorded = await readRecorded(
    queryable,
    sets.map((set) => set.store),
  );
  for (const set of sets) {
    const checksums = await Promise.all(set.migrations.map(schemaMigrationChecksum));
    checkRecorded(set, recorded.get(set.store) ?? new Map(), checksums);
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
