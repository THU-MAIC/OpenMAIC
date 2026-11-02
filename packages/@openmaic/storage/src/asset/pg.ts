/**
 * PostgreSQL registry for server assets over a pluggable byte layer.
 *
 * Within a write, the blob row is claimed first, then the bytes are written,
 * then the entry that references them. The order is load-bearing at both ends:
 * claiming the row first serializes the write against the collector, which
 * could otherwise delete those bytes while this upsert waited for the lock, and
 * writing bytes before the entry keeps every surviving entry backed by bytes
 * that were actually stored. The byte write is unconditional, so both existence
 * paths emit the same statements.
 *
 * The byte write itself must go through the transaction-pinned queryable
 * (`writeWith`) whenever the bytes live in the registry's own PostgreSQL:
 * written on the byte layer's own pooled connection while this transaction
 * holds the blob-row lock, it would block on that lock forever -- a
 * self-deadlock PostgreSQL cannot detect. A byte layer that cannot join the
 * transaction must declare `writesOutsideRegistryDatabase`, or the registry
 * refuses the configuration (see `assertByteWriteIsCoordinatable`).
 *
 * A byte layer outside the registry's database (an object store) is the
 * exception to "claim, write, insert in one transaction": its write is network
 * I/O of arbitrary size, and holding a pooled connection, the blob-row lock and
 * the principal's quota lock across it lets one slow upload stall every other
 * writer. For such a layer a write is staged instead (see {@link
 * PgAssetStore.stageBytes}): a short transaction claims the blob row and
 * records a stage pin in `asset_blob_stages`, the bytes are uploaded with no
 * transaction open, and a second short transaction claims the row again,
 * consumes the pin and inserts the entry. The pin is what keeps the collector
 * away while no lock is held: the collector skips a blob any live pin names,
 * and a pin row cascades away with its blob, so a pin that still exists when
 * it is consumed proves the bytes uploaded after it was recorded were never
 * reclaimed.
 *
 * Request paths never delete bytes; the offline collector is the only reclaimer.
 * `withTransaction` must pin all queries in its body to one freshly checked-out
 * transaction.
 */
import type { AssetMeta, AssetRef, BinaryBlob } from '@openmaic/dsl';
import { contentHashOf, type ContentHash } from './blob.js';
import type { AssetByteStore } from './byte-store.js';
import { newAssetId, type AssetId } from './id.js';
import {
  AssetNotFoundError,
  AssetQuotaExceededError,
  AssetRootedError,
  type AssetBytes,
  type AssetIdentity,
  type AssetIndirectRead,
  type AssetIndirectReadRequest,
  type AssetPrincipal,
  type AssetStore,
} from './types.js';
import { assertJsonValue, isLosslessJsonString } from '../runtime/json-value.js';
import { encodeJson } from '../pg-json.js';
import { applySchemaMigrations, type SchemaMigrationSet } from '../pg-migrations.js';
import type { Queryable, WithTransaction } from '../runtime/pg.js';

export type { QueryResult, Queryable, WithTransaction } from '../runtime/pg.js';
export type { AssetByteStore, AssetSignedReadHeaders } from './byte-store.js';
export type {
  AssetBytes,
  AssetIdentity,
  AssetIndirectRead,
  AssetIndirectReadRequest,
  AssetPrincipal,
  AssetStore,
} from './types.js';
export { AssetNotFoundError, AssetQuotaExceededError, AssetRootedError } from './types.js';
export {
  AssetRootInputError,
  AssetRootTargetError,
  changeAssetRoots,
  type AssetRootChange,
  type ChangeAssetRootsInput,
} from './roots.js';

export interface PgAssetStoreOptions {
  /** Pin each callback to a fresh PostgreSQL transaction and connection. */
  withTransaction: WithTransaction;
  /** Physical byte storage used beneath the registry. */
  byteStore: AssetByteStore;
  /** Optional logical-byte ceiling for each principal. */
  quotaBytes?: number;
  /**
   * How long an allocated entry stays pending before it expires.
   *
   * The window this has to cover is "the bytes were stored, and then the
   * document that names them was saved". A client stores bytes first and
   * writes the id into the document afterwards, and nothing on the wire leases
   * that gap, so the default is deliberately generous rather than tight: a day
   * of unreclaimed bytes costs storage, while an expiry that fires before the
   * document write costs the document its media.
   *
   * Expiry only matters to a deployment that runs the collector's entry pass
   * (`AssetCollector`'s `documentReferences` option); without it the column is
   * written and never read.
   */
  pendingTtlMs?: number;
  /**
   * How long a stage pin (see {@link PgAssetStore.stageBytes}) protects its
   * bytes: the bound on an object-store upload plus, for `putStaged`, the gap
   * before the allocating transaction. The collector does not reclaim a blob
   * while a live pin names it; a pin past this deadline is dead, so an upload
   * or allocation that outlives it fails rather than trusting bytes the
   * collector may already have removed. It also bounds how long an abandoned
   * stage holds its bytes back from reclamation.
   */
  stageTtlMs?: number;
}

/** One day. A deployment may choose a longer window. */
export const DEFAULT_ASSET_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** One day: far beyond any upload, short enough to drain abandoned stages. */
export const DEFAULT_ASSET_STAGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * One PGlite-compatible statement per entry, in dependency order.
 *
 * The three lifecycle columns on `asset_entries` and the `document_asset_refs`
 * table carry the entry level of reference counting, mirroring one level up
 * what `asset_blobs.unreferenced_at` already does for bytes:
 *
 * - `expires_at` is set when an entry is allocated and cleared when a document
 *   first names it. An entry no document ever names therefore has a deadline
 *   rather than living forever.
 * - `committed_at` is stamped by that same first document write. `NULL` means
 *   pending; it is never read on a request path.
 * - `unreferenced_at` is stamped when a write removes the entry's last
 *   reference row -- of either kind below -- so an entry drains after a grace
 *   period instead of immediately, and cleared by the document write paths
 *   and by adding a root when a reference arrives back. The collector's backfill is the one reference-adding writer
 *   that does NOT clear it: it deliberately touches no lifecycle column, so a
 *   walk that re-references a stamped entry leaves it referenced AND stamped.
 *   That is a normal intermediate state and a safe one -- the entry pass never
 *   releases a referenced entry, and the next document write to that document
 *   normalizes the columns.
 *
 * `document_asset_refs.scope` separates the stage-level slot -- stage
 * whiteboards and the stage video manifest, which no scene owns -- from a
 * scene's own slots, and is part of the primary key. It is a column rather
 * than a reserved `scene_id` value because scene ids are opaque and
 * unconstrained: a scene whose id happened to equal any sentinel would
 * otherwise share a key with the stage-level rows, and one scope's write
 * would silently delete the other's. Stage rows carry `scene_id = ''`, which
 * is then a value nothing keys on rather than a reservation.
 *
 * The table deliberately carries no foreign key to `document_stages`: the
 * document schema is a different backend that a deployment may not provision
 * at all, and the reference rows are maintained explicitly by the document
 * store (see `./references.ts`) rather than by a cascade.
 *
 * `asset_root_refs` is the second kind of reference: an explicit root that
 * keeps an entry alive for as long as the row exists, written by a caller
 * that owns something outside any document (see `./roots.ts`). Its
 * `(root_kind, root_id)` pair is opaque to this package -- storage never
 * interprets either -- and the lifecycle treats a root exactly like a
 * document reference: an entry named by a row in EITHER table is referenced.
 * A root keeps an entry alive and nothing more; in particular it does not make
 * the entry readable by any other principal. Like `document_asset_refs` it
 * cascades with its entry in the database, but the generic mutation paths
 * never get that far: `remove` and `replace` refuse an entry any root holds
 * ({@link AssetRootedError}), so only a direct row delete would take a root
 * with its entry.
 *
 * `asset_reference_tracking` is a one-row marker, written by a document store
 * configured to maintain references and read by the collector before its
 * entry pass. It exists because the two halves are separately configured and
 * the failure mode of enabling only the second is silent deletion of live
 * media: an empty `document_asset_refs` cannot be told apart from documents
 * that reference nothing, but the absence of this marker can. Its
 * `rule_version` is the highest reference-rule version a writer on this
 * database applies (`ASSET_REFERENCE_RULE_VERSION`); a marker an older
 * writer created reads 1, documents only.
 *
 * `document_asset_withdrawals` records that a host has retired a document
 * while keeping its rows, so the collector's one-time backfill does not walk
 * that document's stored JSON and re-reference what the retirement released.
 * A row here is the only durable trace of a retirement -- the document itself
 * looks exactly like a live one, by design, because the retirement belongs to
 * the host's own tombstone and not to this schema -- and therefore the only
 * thing that may make that walk skip a document. Every write path that
 * maintains references removes the row -- a write that re-establishes the
 * document's references, and a delete on a store that tracks them -- so under
 * a single, consistent configuration the record never outlives what it
 * describes. A delete issued by a store with tracking OFF cannot clear it,
 * because that store may be running against a database with no asset schema
 * at all; a stale record then survives its document and would make the walk
 * skip whatever later claims that id. That is one more reason for the rule
 * `docs/reference-server.md` already gives: do not mix tracking states on one
 * database (see `./references.ts`).
 */
const ASSET_PG_BASELINE: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS asset_blobs (
     content_hash TEXT PRIMARY KEY,
     byte_size BIGINT NOT NULL,
     bytes BYTEA,
     unreferenced_at TIMESTAMPTZ
   )`,
  `CREATE TABLE IF NOT EXISTS asset_entries (
     id TEXT PRIMARY KEY,
     principal TEXT NOT NULL,
     content_hash TEXT NOT NULL REFERENCES asset_blobs(content_hash),
     mime TEXT NOT NULL,
     meta JSONB NOT NULL,
     revision INTEGER NOT NULL DEFAULT 1,
     created_at DOUBLE PRECISION NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS asset_entries_principal_idx
     ON asset_entries (principal, id)`,
  `CREATE INDEX IF NOT EXISTS asset_entries_content_hash_idx
     ON asset_entries (content_hash)`,
  `CREATE INDEX IF NOT EXISTS asset_blobs_unreferenced_idx
     ON asset_blobs (unreferenced_at) WHERE unreferenced_at IS NOT NULL`,
  `ALTER TABLE asset_entries
     ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ`,
  `ALTER TABLE asset_entries
     ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
  `ALTER TABLE asset_entries
     ADD COLUMN IF NOT EXISTS unreferenced_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS document_asset_refs (
     stage_id TEXT NOT NULL,
     scope TEXT NOT NULL CHECK (scope IN ('stage', 'scene')),
     scene_id TEXT NOT NULL,
     asset_id TEXT NOT NULL REFERENCES asset_entries(id) ON DELETE CASCADE,
     PRIMARY KEY (stage_id, scope, scene_id, asset_id)
   )`,
  `CREATE INDEX IF NOT EXISTS document_asset_refs_asset_idx
     ON document_asset_refs (asset_id)`,
  `CREATE INDEX IF NOT EXISTS asset_entries_expires_idx
     ON asset_entries (expires_at) WHERE expires_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS asset_entries_unreferenced_idx
     ON asset_entries (unreferenced_at) WHERE unreferenced_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS asset_entries_legacy_idx
     ON asset_entries (id) WHERE committed_at IS NULL AND expires_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS asset_reference_tracking (
     singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
     enabled_at TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS document_asset_withdrawals (
     stage_id TEXT NOT NULL PRIMARY KEY,
     withdrawn_at TIMESTAMPTZ NOT NULL
   )`,
];

const ASSET_PG_ROOTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS asset_root_refs (
     root_kind TEXT NOT NULL,
     root_id TEXT NOT NULL,
     asset_id TEXT NOT NULL REFERENCES asset_entries(id) ON DELETE CASCADE,
     PRIMARY KEY (root_kind, root_id, asset_id)
   )`,
  `CREATE INDEX IF NOT EXISTS asset_root_refs_asset_idx
     ON asset_root_refs (asset_id)`,
  `ALTER TABLE asset_reference_tracking
     ADD COLUMN IF NOT EXISTS rule_version INTEGER NOT NULL DEFAULT 1`,
];

/**
 * `asset_blob_stages` holds one pin per staged byte write (see
 * {@link PgAssetStore.stageBytes}): a blob whose bytes are being uploaded, or
 * have been uploaded and not yet claimed by an entry, with no transaction held
 * across the upload. The collector skips a blob any unexpired pin names, and
 * the foreign key cascades, so reclaiming a blob takes its pins with it and a
 * pin's mere existence proves its blob was not reclaimed since the pin was
 * written. `expires_at` bounds how long an abandoned stage keeps its blob.
 */
const ASSET_PG_STAGES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS asset_blob_stages (
     id TEXT PRIMARY KEY,
     content_hash TEXT NOT NULL REFERENCES asset_blobs(content_hash) ON DELETE CASCADE,
     expires_at TIMESTAMPTZ NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS asset_blob_stages_content_hash_idx
     ON asset_blob_stages (content_hash)`,
  `CREATE INDEX IF NOT EXISTS asset_blob_stages_expires_idx
     ON asset_blob_stages (expires_at)`,
];

export const ASSET_PG_SCHEMA: readonly string[] = [
  ...ASSET_PG_BASELINE,
  ...ASSET_PG_ROOTS,
  ...ASSET_PG_STAGES,
];

/** The asset backend's migrations, recorded under the store `asset`. */
export const ASSET_PG_MIGRATIONS: SchemaMigrationSet = {
  store: 'asset',
  migrations: [
    { version: 1, name: 'baseline', up: ASSET_PG_BASELINE.join(';\n'), transaction: false },
    { version: 2, name: 'material_roots', up: ASSET_PG_ROOTS.join(';\n'), transaction: true },
    { version: 3, name: 'blob_stages', up: ASSET_PG_STAGES.join(';\n'), transaction: true },
  ],
};

/**
 * Create the tables owned by this backend, or bring an existing database up to
 * date, by applying the pending {@link ASSET_PG_MIGRATIONS}. Safe to call on
 * every start; a schema change is a new migration.
 */
export async function ensureAssetSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, ASSET_PG_MIGRATIONS);
}

interface UsageRow extends Record<string, unknown> {
  logical_bytes: number | string;
}

interface ReplaceUsageRow extends UsageRow {
  current_bytes: number | string;
  current_counts: boolean;
}

interface EntryRow extends Record<string, unknown> {
  content_hash: ContentHash;
  mime: string;
  meta: unknown;
  revision: number | string;
}

interface IdentityRow extends Record<string, unknown> {
  mime: string;
  revision: number | string;
  byte_size: number | string;
}

interface HashRow extends Record<string, unknown> {
  content_hash: ContentHash;
}

interface TransactionalByteWriter extends AssetByteStore {
  writeWith(queryable: Queryable, hash: ContentHash, bytes: Uint8Array): Promise<void>;
}

interface TransactionalByteReader extends AssetByteStore {
  readWith(queryable: Queryable, hash: ContentHash): Promise<Uint8Array | null>;
}

function hasTransactionalWriter(store: AssetByteStore): store is TransactionalByteWriter {
  return 'writeWith' in store && typeof store.writeWith === 'function';
}

function hasTransactionalReader(store: AssetByteStore): store is TransactionalByteReader {
  return 'readWith' in store && typeof store.readWith === 'function';
}

/**
 * Bytes uploaded by {@link PgAssetStore.stageBytes} and not yet claimed by an
 * entry. Opaque: the content hash and the stage pin it stands for stay inside
 * this module, so a handle can only be spent by {@link PgAssetStore.putStaged}.
 */
export interface StagedAssetBytes {
  /** Length of the staged bytes. */
  readonly byteLength: number;
  /** The staged blob's own media type, used when no `contentType` is given. */
  readonly type: string;
}

interface StagedRecord {
  stageId: string;
  contentHash: ContentHash;
  byteLength: number;
  type: string;
}

const stagedRecords = new WeakMap<StagedAssetBytes, StagedRecord>();

/**
 * When a stage pin is alive: strictly before its deadline, read on the wall
 * clock at the moment of the check.
 *
 * An expired pin is dead even while its row still exists, and must never be
 * revived. The collector treats it as dead -- it deletes the bytes, which no
 * rollback restores, before deleting the blob row the pin cascades with -- so
 * a collector transaction that fails between those two steps leaves the row
 * and the expired pin behind with the bytes gone. `clock_timestamp()` rather
 * than `now()`: `now()` is the transaction's start, and an allocating
 * transaction that waited on a lock would otherwise judge the pin by a time
 * before a collector that ran meanwhile. The collector judges by its own
 * `now()`, which is never later than when it acts, so any check made after a
 * collector deleted bytes sees the pin as dead too.
 */
const STAGE_PIN_LIVE_SQL = 'expires_at > clock_timestamp()';

/**
 * Renew a live stage pin's deadline, or find it dead or gone.
 *
 * Preceded, in the same transaction, by a shared lock on the pin's blob row
 * ({@link LOCK_STAGED_BLOB_SQL}), so every pin write is ordered against the
 * collector by that row, as the stage's insert and the allocation's claim
 * are. Without it a renewal could decide the pin is live, and the collector
 * -- holding the row but reading the pin before the renewal commits -- could
 * judge the old, now-expired deadline and delete the bytes, leaving a renewed
 * pin over bytes that are gone if its transaction then failed before deleting
 * the row.
 */
const RENEW_STAGE_SQL = `UPDATE asset_blob_stages
    SET expires_at = clock_timestamp() + ($2::double precision * interval '1 millisecond')
  WHERE id = $1 AND ${STAGE_PIN_LIVE_SQL}
  RETURNING id`;

/** The blob-row lock a renewal takes before its pin: row before pin, always. */
const LOCK_STAGED_BLOB_SQL = `SELECT 1 FROM asset_blobs WHERE content_hash = $1 FOR SHARE`;

/**
 * Bound on how long one registry write transaction may wait on a lock.
 *
 * Every registry lock wait in a healthy deployment is short: the blob-row
 * claim serializes against the collector (a transaction per blob) or against a
 * concurrent writer of the same content, and the principal quota lock waits
 * only for a same-principal write already in flight. A wait that outlives this
 * bound is a stuck transaction or a lock-contention bug, and must surface as a
 * loud error rather than hang a request or an agent turn for as long as the
 * holder stays stuck.
 */
const REGISTRY_WRITE_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '30s'`;

/** The savepoint every registry write body runs under (see `writeTransaction`). */
const REGISTRY_WRITE_SAVEPOINT = 'openmaic_asset_registry_write';

function registryConfigurationFailure(problem: string): Error {
  return new Error(`@openmaic/storage: ${problem}`);
}

function registryFailure(operation: string): Error {
  return new Error(`@openmaic/storage: asset registry ${operation} failed`);
}

class RegistryAssetNotFound extends Error {}

class RegistryAssetQuotaExceeded extends Error {}

/** A stage pin was reclaimed (it expired) before its entry could claim it. */
class RegistryStageLost extends Error {}

/**
 * Whether a reference root holds `id`, read in a statement of its own.
 *
 * Callers run it right after taking the entry's `FOR UPDATE`. A root insert
 * takes `KEY SHARE` on the entry (the foreign key) after the root writer's
 * `FOR NO KEY UPDATE`, so it either committed before that lock was granted --
 * and this fresh READ COMMITTED snapshot sees it -- or it waits behind this
 * transaction. Folding the check into the `DELETE` as `NOT EXISTS` would not
 * do: the subquery keeps the statement's snapshot even after the row lock
 * wait, so a root committed meanwhile would go unseen and the cascade would
 * take it away.
 */
async function entryIsRooted(queryable: Queryable, id: string): Promise<boolean> {
  const rooted = await queryable.query<{ rooted: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM asset_root_refs WHERE asset_id = $1) AS rooted`,
    [id],
  );
  return rooted.rows[0]?.rooted === true;
}

function replaceFailure(error: unknown): Error {
  if (error instanceof RegistryAssetNotFound) return new AssetNotFoundError();
  if (error instanceof RegistryAssetQuotaExceeded) return new AssetQuotaExceededError();
  if (error instanceof AssetRootedError) return error;
  return registryFailure('replace');
}

function encodeMeta(meta: AssetMeta): string {
  assertJsonValue(meta, 'asset metadata');
  return encodeJson(meta, 'asset metadata');
}

function byteView(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

export class PgAssetStore implements AssetStore {
  private readonly transactionHook: WithTransaction;
  private readonly byteStore: AssetByteStore;
  private readonly quotaBytes?: number;
  private readonly pendingTtlMs: number;
  private readonly stageTtlMs: number;

  constructor(
    private readonly queryable: Queryable,
    options: PgAssetStoreOptions,
  ) {
    if (typeof options?.withTransaction !== 'function') {
      throw new Error(
        '@openmaic/storage: withTransaction is required and must pin a fresh connection and transaction for every call',
      );
    }
    if (!options.byteStore) {
      throw new Error('@openmaic/storage: byteStore is required for PgAssetStore');
    }
    if (
      options.quotaBytes !== undefined &&
      (!Number.isSafeInteger(options.quotaBytes) || options.quotaBytes < 0)
    ) {
      throw new Error('@openmaic/storage: quotaBytes must be a non-negative safe integer');
    }
    if (
      options.pendingTtlMs !== undefined &&
      (!Number.isSafeInteger(options.pendingTtlMs) || options.pendingTtlMs < 1)
    ) {
      throw new Error('@openmaic/storage: pendingTtlMs must be a positive safe integer');
    }
    if (
      options.stageTtlMs !== undefined &&
      (!Number.isSafeInteger(options.stageTtlMs) || options.stageTtlMs < 1)
    ) {
      throw new Error('@openmaic/storage: stageTtlMs must be a positive safe integer');
    }
    this.transactionHook = options.withTransaction;
    this.byteStore = options.byteStore;
    this.quotaBytes = options.quotaBytes;
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_ASSET_PENDING_TTL_MS;
    this.stageTtlMs = options.stageTtlMs ?? DEFAULT_ASSET_STAGE_TTL_MS;
  }

  private transaction<T>(body: (queryable: Queryable) => Promise<T>): Promise<T> {
    return this.transactionHook(body);
  }

  /**
   * A write transaction: the same fresh pinned connection as
   * {@link transaction}, plus a lock-wait budget, so a future lock-contention
   * variant of a registry write fails loudly instead of hanging.
   *
   * The body also runs under a savepoint, so a write that fails leaves
   * nothing behind whatever the transaction it ran in does next. On a store
   * bound to fresh transactions that changes nothing: a failing body rolls the
   * whole transaction back anyway. On a store bound to a caller's open
   * transaction there is no inner transaction to roll back, and a caller that
   * catches the error and commits its own work would otherwise commit
   * whatever statements of the failed write had already run -- a blob row
   * claimed, a stamp cleared, an entry locked -- with nothing to undo them.
   * Rolling back to the savepoint also leaves the caller's transaction usable
   * after a statement error, and releases the locks the write took.
   */
  private writeTransaction<T>(body: (queryable: Queryable) => Promise<T>): Promise<T> {
    return this.transactionHook(async (queryable) => {
      await queryable.query(REGISTRY_WRITE_LOCK_TIMEOUT_SQL);
      await queryable.query(`SAVEPOINT ${REGISTRY_WRITE_SAVEPOINT}`);
      let result: T;
      try {
        result = await body(queryable);
      } catch (error) {
        try {
          await queryable.query(`ROLLBACK TO SAVEPOINT ${REGISTRY_WRITE_SAVEPOINT}`);
        } catch {
          // The connection is gone or the transaction is beyond saving; the
          // caller's own rollback (or the failed commit) then discards it.
        }
        throw error;
      }
      await queryable.query(`RELEASE SAVEPOINT ${REGISTRY_WRITE_SAVEPOINT}`);
      return result;
    });
  }

  /**
   * Refuse the self-deadlock configuration up front: a byte store that writes
   * to the registry's own PostgreSQL but cannot join the registry's
   * transaction would issue its byte write on a second pooled connection while
   * this transaction holds the blob-row lock. That write blocks forever on the
   * lock the transaction just took, and the transaction waits on the write --
   * a deadlock PostgreSQL cannot detect, because one side is idle in
   * transaction. A store either joins the transaction (`writeWith`) or
   * declares that its bytes live outside the registry's database
   * ({@link AssetByteStore.writesOutsideRegistryDatabase}); anything else is a
   * configuration error, thrown here before any row is claimed.
   */
  private assertByteWriteIsCoordinatable(): void {
    if (hasTransactionalWriter(this.byteStore)) return;
    if (this.byteStore.writesOutsideRegistryDatabase === true) return;
    throw registryConfigurationFailure(
      'the asset byte store cannot coordinate byte writes with the registry. A byte store without ' +
        'writeWith() writes on its own connection; if it writes to the same PostgreSQL as the ' +
        'registry, that write blocks forever on the blob-row lock the registry transaction just ' +
        'took (a self-deadlock PostgreSQL cannot detect). Provide a transaction-pinned writeWith(), ' +
        'or declare writesOutsideRegistryDatabase: true when the bytes genuinely live outside the ' +
        "registry's database (for example in an object store).",
    );
  }

  private async coordinatedWrite(
    queryable: Queryable,
    hash: ContentHash,
    bytes: Uint8Array,
  ): Promise<void> {
    if (hasTransactionalWriter(this.byteStore)) {
      await this.byteStore.writeWith(queryable, hash, bytes);
      return;
    }
    if (this.byteStore.writesOutsideRegistryDatabase === true) {
      await this.byteStore.write(hash, bytes);
      return;
    }
    // Defense in depth: the entry-point check above should have refused this
    // configuration before any transaction opened. Keep the guard here too so
    // a future call path cannot fall into the deadlock silently.
    this.assertByteWriteIsCoordinatable();
  }

  /**
   * Whether byte writes are staged (see {@link stageBytes}) rather than issued
   * inside the write transaction. Exactly the layers that cannot join the
   * transaction and have declared their bytes live elsewhere: an in-database
   * layer writes through the transaction it is coordinated with, which is
   * correct and cheap, so it keeps the single-transaction path.
   *
   * A host that allocates inside its own transaction uses this to decide
   * whether {@link stageBytes} buys anything: with an in-database layer it
   * would only add a transaction, so such a host keeps calling `put`.
   */
  stagesByteWrites(): boolean {
    return (
      !hasTransactionalWriter(this.byteStore) &&
      this.byteStore.writesOutsideRegistryDatabase === true
    );
  }

  /**
   * Claim the blob row for an entry about to name it: insert it, or clear its
   * unreferenced stamp, taking the row lock that serializes this write against
   * the collector and against a concurrent writer of the same content.
   */
  private async claimBlobRow(
    queryable: Queryable,
    hash: ContentHash,
    byteLength: number,
  ): Promise<void> {
    await queryable.query(
      `INSERT INTO asset_blobs (content_hash, byte_size, unreferenced_at)
       VALUES ($1, $2, NULL)
       ON CONFLICT (content_hash) DO UPDATE
         SET unreferenced_at = NULL,
             byte_size = EXCLUDED.byte_size`,
      [hash, byteLength],
    );
  }

  /**
   * Claim the blob row of a staged write and spend its pin, in that order.
   *
   * The row lock comes first, so a collector already holding it finishes
   * before the pin is looked at: if it reclaimed the blob, the pin cascaded
   * away with the row and is not found here. A pin that is found AND still
   * live was never reclaimed with its blob -- the collector skips a blob any
   * live pin names -- and the blob row cannot have been deleted and re-created
   * underneath it either (deleting the row deletes the pin), so the bytes the
   * stage uploaded after writing the pin are still stored. An expired pin is
   * refused even when its row survives: a collector may have deleted its bytes
   * and then failed before deleting the row (see {@link STAGE_PIN_LIVE_SQL}).
   * With the row lock held from here to commit, the collector cannot start on
   * it.
   */
  private async claimStagedBlob(queryable: Queryable, staged: StagedRecord): Promise<void> {
    // Lock, verify, then mutate: the blob row is locked without being
    // changed, the pin is spent only if it is live, and only then is the
    // row's reclamation stamp cleared. A dead or reclaimed stage therefore
    // fails before anything about the blob changes -- no row created for
    // bytes that may be gone, no stamp cleared on a blob nothing will name --
    // and the lock order (blob row, then pin) is the one every pin writer
    // and the collector use. The pin's foreign key means a live pin implies
    // the row, so there is nothing to insert.
    const locked = await queryable.query(
      'SELECT 1 FROM asset_blobs WHERE content_hash = $1 FOR UPDATE',
      [staged.contentHash],
    );
    if (!locked.rows[0]) throw new RegistryStageLost();
    const consumed = await queryable.query(
      `DELETE FROM asset_blob_stages
        WHERE id = $1 AND content_hash = $2 AND ${STAGE_PIN_LIVE_SQL}
        RETURNING id`,
      [staged.stageId, staged.contentHash],
    );
    if (!consumed.rows[0]) throw new RegistryStageLost();
    await queryable.query('UPDATE asset_blobs SET unreferenced_at = NULL WHERE content_hash = $1', [
      staged.contentHash,
    ]);
  }

  /**
   * Store bytes with a stage pin, holding no transaction across the byte
   * write itself.
   *
   * 1. A short transaction claims the blob row -- a new row is stamped
   *    unreferenced now, so an abandoned stage leaves bytes the collector
   *    reclaims rather than a row nothing will ever stamp -- and records a pin
   *    that expires after `stageTtlMs`. Claiming the row first makes this
   *    wait out a collector that already holds it, so the pin is written
   *    either before the collector can lock the row (and the collector, which
   *    re-reads pins under that lock, skips the blob) or after it has deleted
   *    the row and its bytes (and the bytes below are written after that).
   * 2. The bytes are written with no transaction or connection held.
   *    Content-addressed and idempotent, so concurrent stages of the same
   *    content may both write.
   * 3. A short transaction takes a shared lock on the blob row and renews the
   *    pin, which both restarts its deadline from the end of the upload and
   *    proves it was not reclaimed during it (see {@link RENEW_STAGE_SQL}).
   *
   * An in-database layer writes its bytes inside step 1 instead, through the
   * transaction it is coordinated with. Every path runs the same statements
   * whether or not the content was already stored.
   *
   * `lockAhead` runs first in step 1 and takes, in their usual order, the
   * locks the allocating transaction will take before it reaches the blob
   * row: the principal's quota lock, and for `replace` the entry's row lock.
   * On a store bound to fresh transactions they are released at once and cost
   * a few statements. On a store bound to a caller's open transaction, step 1
   * and the allocation share that transaction, so the blob-row lock taken
   * here is held until the caller commits; without the locks ahead of it that
   * transaction would hold the blob row and then wait for the principal's
   * lock -- the reverse of every other writer, which takes the principal's
   * lock and then waits for the blob row, and a deadlock between the two.
   */
  private async stage(
    contentHash: ContentHash,
    bytes: Uint8Array,
    type: string,
    lockAhead?: (queryable: Queryable) => Promise<void>,
  ): Promise<StagedRecord> {
    const stageId = crypto.randomUUID();
    const store = this.byteStore;
    const ttl = this.stageTtlMs;
    await this.writeTransaction(async (queryable) => {
      await lockAhead?.(queryable);
      await queryable.query(
        `INSERT INTO asset_blobs (content_hash, byte_size, unreferenced_at)
         VALUES ($1, $2, now())
         ON CONFLICT (content_hash) DO UPDATE
           SET byte_size = EXCLUDED.byte_size`,
        [contentHash, bytes.byteLength],
      );
      await queryable.query(
        `INSERT INTO asset_blob_stages (id, content_hash, expires_at)
         VALUES ($1, $2, clock_timestamp() + ($3::double precision * interval '1 millisecond'))`,
        [stageId, contentHash, ttl],
      );
      if (hasTransactionalWriter(store)) await store.writeWith(queryable, contentHash, bytes);
    });
    if (!hasTransactionalWriter(store)) {
      try {
        await store.write(contentHash, bytes);
        const renewed = await this.writeTransaction(async (queryable) => {
          await queryable.query(LOCK_STAGED_BLOB_SQL, [contentHash]);
          return queryable.query(RENEW_STAGE_SQL, [stageId, ttl]);
        });
        if (!renewed.rows[0]) {
          await this.reregisterOutlivedUpload(contentHash, bytes.byteLength);
          throw new RegistryStageLost();
        }
      } catch (error) {
        await this.releaseStage(stageId);
        throw error;
      }
    }
    return { stageId, contentHash, byteLength: bytes.byteLength, type };
  }

  /**
   * Make the bytes of an upload that outlived its pin reclaimable again.
   *
   * Once the pin is dead the collector may have deleted the blob row (and the
   * object) while the upload was still in flight, and an upload that finishes
   * after that delete leaves an object no row names -- invisible to the
   * collector, which only reclaims bytes it has a row for. Inserting a row
   * stamped unreferenced now puts such an object back under collection after
   * the ordinary grace period. `DO NOTHING` on a row that exists: then the
   * blob is still tracked (the collector has not taken it, or a concurrent
   * writer has re-created it), and its state is that writer's to keep. The
   * insert takes only the blob row, so it fits every lock order. Best effort:
   * a failure here leaves an orphan object, which costs storage and names
   * nothing.
   */
  private async reregisterOutlivedUpload(
    contentHash: ContentHash,
    byteLength: number,
  ): Promise<void> {
    try {
      await this.writeTransaction((queryable) =>
        queryable.query(
          `INSERT INTO asset_blobs (content_hash, byte_size, unreferenced_at)
           VALUES ($1, $2, now())
           ON CONFLICT (content_hash) DO NOTHING`,
          [contentHash, byteLength],
        ),
      );
    } catch {
      // An untracked object is a storage leak, never a dangling entry.
    }
  }

  /**
   * Drop a stage pin nothing will claim, so its blob drains on the ordinary
   * grace period instead of waiting out the pin. Best effort: a pin left
   * behind only delays reclamation until it expires.
   */
  private async releaseStage(stageId: string): Promise<void> {
    try {
      await this.transaction((queryable) =>
        queryable.query('DELETE FROM asset_blob_stages WHERE id = $1', [stageId]),
      );
    } catch {
      // The pin expires on its own.
    }
  }

  /**
   * Give up a stage {@link stageBytes} answered and nothing will spend, so its
   * bytes drain on the collector's ordinary grace period instead of waiting
   * out `stageTtlMs`. Idempotent: releasing a spent, released, expired or
   * foreign handle does nothing. Best effort -- a failure leaves the pin to
   * expire on its own -- and never throws. Call it on a store bound to fresh
   * transactions, after the transaction that would have spent the handle has
   * ended: inside that transaction it would be rolled back with it.
   */
  async releaseStaged(staged: StagedAssetBytes): Promise<void> {
    const record = stagedRecords.get(staged);
    if (!record) return;
    await this.releaseStage(record.stageId);
  }

  /**
   * Upload bytes ahead of the transaction that will allocate an entry for
   * them, and answer a handle {@link putStaged} spends.
   *
   * For a host that allocates inside a transaction of its own (a store bound
   * to an open transaction, so `put` cannot commit anything by itself):
   * calling `put` there would keep that transaction, its connection and every
   * lock it holds open across the byte upload. Instead, call `stageBytes` on a
   * store bound to fresh transactions BEFORE opening that transaction, then
   * `putStaged` on the transaction-bound store inside it. The upload then runs
   * with no transaction open; the allocation keeps every guarantee of `put`
   * (the principal's quota is checked under its lock, in the host's
   * transaction).
   *
   * Nothing names the staged bytes until `putStaged` commits. A stage that is
   * never spent should be given back with {@link releaseStaged}; otherwise it
   * expires after `stageTtlMs`, and the collector then reclaims its bytes on
   * the ordinary grace period. `putStaged` on an expired stage fails like any
   * other registry failure, and the caller stages again.
   * Called on a store bound to an open transaction, the stage runs inside it
   * and is no better than `put`.
   *
   * The handle is a process-local capability: it is valid only in the process
   * and the copy of this package that answered it (it is not serializable,
   * and a second copy of the package does not recognize it), and it is not
   * bound to a principal -- whoever holds it decides which principal
   * `putStaged` allocates for, with that principal's quota.
   */
  async stageBytes(data: BinaryBlob): Promise<StagedAssetBytes> {
    this.assertByteWriteIsCoordinatable();
    const { contentHash, bytes: buffer } = await contentHashOf(data);
    let record: StagedRecord;
    try {
      record = await this.stage(contentHash, byteView(buffer), data.type);
    } catch {
      throw registryFailure('stage');
    }
    const handle: StagedAssetBytes = Object.freeze({
      byteLength: record.byteLength,
      type: record.type,
    });
    stagedRecords.set(handle, record);
    return handle;
  }

  /**
   * Allocate an entry for bytes {@link stageBytes} uploaded: `put`, without
   * the byte write. A handle is spent by the first allocation that commits;
   * one whose transaction rolled back may be spent again.
   */
  async putStaged(
    principal: AssetPrincipal,
    staged: StagedAssetBytes,
    meta?: AssetMeta,
  ): Promise<AssetId> {
    const record = stagedRecords.get(staged);
    if (!record) {
      throw new Error('@openmaic/storage: putStaged takes a handle returned by stageBytes');
    }
    const storedMeta = meta ?? {};
    const encodedMeta = encodeMeta(storedMeta);
    const mime = storedMeta.contentType ?? record.type;
    let id: AssetId;
    try {
      id = newAssetId();
    } catch {
      throw registryFailure('put');
    }
    await this.allocateStaged(principal, id, record, mime, encodedMeta);
    return id;
  }

  private async insertPendingEntry(
    queryable: Queryable,
    id: AssetId,
    principal: AssetPrincipal,
    contentHash: ContentHash,
    mime: string,
    encodedMeta: string,
  ): Promise<void> {
    // The entry is allocated PENDING: `committed_at` stays NULL until the
    // first document write names this id, and `expires_at` is the deadline
    // for that write to arrive. The columns are written unconditionally on
    // every put, and no READ path reads them -- see `resolve` / `identify`
    // / `resolveIndirect`, none of which mention them -- so the pending and
    // committed states are indistinguishable to a caller. The one
    // deliberate exception is `unreferenced_at`, which the quota checks on
    // `put` and `replace` read: quota is accounted on live logical bytes,
    // and the asset contract states that branch explicitly.
    await queryable.query(
      `INSERT INTO asset_entries
         (id, principal, content_hash, mime, meta, revision, created_at,
          committed_at, expires_at, unreferenced_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 1, $6,
               NULL, now() + ($7::double precision * interval '1 millisecond'), NULL)`,
      [id, principal.key, contentHash, mime, encodedMeta, Date.now(), this.pendingTtlMs],
    );
  }

  /**
   * The allocating transaction of a staged write: quota under the principal's
   * lock, the blob row and the pin, then the entry. No byte I/O, so every lock
   * here is held for a few statements.
   */
  private async allocateStaged(
    principal: AssetPrincipal,
    id: AssetId,
    record: StagedRecord,
    mime: string,
    encodedMeta: string,
  ): Promise<void> {
    try {
      await this.writeTransaction(async (queryable) => {
        await this.assertPutQuota(queryable, principal, record.byteLength);
        await this.claimStagedBlob(queryable, record);
        await this.insertPendingEntry(
          queryable,
          id,
          principal,
          record.contentHash,
          mime,
          encodedMeta,
        );
      });
    } catch (error) {
      if (error instanceof RegistryAssetQuotaExceeded) throw new AssetQuotaExceededError();
      throw registryFailure('put');
    }
  }

  /**
   * Serialize this principal's writes before reading their usage.
   *
   * A quota read outside the write transaction is stale by the time it is
   * used: two concurrent writes both observe the old total, both pass, and the
   * principal ends up over quota by as much as the concurrency allows. The
   * lock is transaction-scoped, so it releases on commit or rollback, and it
   * is taken only when a quota is configured -- a branch on deployment
   * configuration, never on data, so it discloses nothing.
   */
  private async lockPrincipal(queryable: Queryable, principal: AssetPrincipal): Promise<void> {
    // hashtextextended is 64-bit: hashtext is 32-bit, and colliding principals
    // would block each other for the whole transaction -- which, for a layer
    // that joins the transaction, spans the byte write.
    await queryable.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [principal.key]);
  }

  private async assertPutQuota(
    queryable: Queryable,
    principal: AssetPrincipal,
    addedBytes: number,
    lock = true,
  ): Promise<void> {
    if (this.quotaBytes === undefined) return;
    if (lock) await this.lockPrincipal(queryable, principal);
    let result;
    try {
      result = await queryable.query<UsageRow>(
        // Everything not yet stamped unreferenced. An entry whose last
        // document reference is gone is on its way out, so counting it would
        // make a regeneration cost quota forever instead of only until the
        // collector's grace period passes. The predicate is exactly that and
        // nothing more: a pending entry counts whether or not its expiry has
        // passed, because only the entry pass removes it, and a quota that
        // over-counts for one collection interval refuses a write slightly
        // early rather than admitting one it should not.
        `SELECT COALESCE(SUM(blobs.byte_size), 0)::text AS logical_bytes
           FROM asset_entries AS entries
           JOIN asset_blobs AS blobs ON blobs.content_hash = entries.content_hash
          WHERE entries.principal = $1 AND entries.unreferenced_at IS NULL`,
        [principal.key],
      );
    } catch {
      throw registryFailure('quota check');
    }
    const used = Number(result.rows[0]?.logical_bytes ?? 0);
    if (used + addedBytes > this.quotaBytes) throw new RegistryAssetQuotaExceeded();
  }

  private async assertReplaceQuota(
    queryable: Queryable,
    principal: AssetPrincipal,
    ref: AssetId,
    replacementBytes: number,
    lock = true,
  ): Promise<void> {
    if (this.quotaBytes === undefined) return;
    if (lock) await this.lockPrincipal(queryable, principal);
    let result;
    try {
      result = await queryable.query<ReplaceUsageRow>(
        // Same live-entry sum as assertPutQuota. `current_counts` says whether
        // the entry being replaced is part of that sum: replace leaves the
        // lifecycle columns alone, so an entry that has already lost its last
        // reference is outside the sum before the replace and still outside it
        // after, and neither its old nor its new bytes may move the total.
        `SELECT current_blob.byte_size::text AS current_bytes,
                current_entry.unreferenced_at IS NULL AS current_counts,
                usage.logical_bytes
           FROM asset_entries AS current_entry
           JOIN asset_blobs AS current_blob
             ON current_blob.content_hash = current_entry.content_hash
           CROSS JOIN (
             SELECT COALESCE(SUM(blobs.byte_size), 0)::text AS logical_bytes
               FROM asset_entries AS entries
               JOIN asset_blobs AS blobs ON blobs.content_hash = entries.content_hash
              WHERE entries.principal = $2 AND entries.unreferenced_at IS NULL
           ) AS usage
          WHERE current_entry.id = $1 AND current_entry.principal = $2`,
        [ref, principal.key],
      );
    } catch {
      throw registryFailure('quota check');
    }
    const row = result.rows[0];
    if (!row) throw new RegistryAssetNotFound();
    // The post-state of the live sum, which is what a quota bounds. An entry
    // outside the sum contributes neither term, so replacing it is a no-op
    // against the quota rather than a charge for bytes that will not be
    // counted -- a check whose own refusal could not be explained by the
    // total it protects.
    const countsLive = row.current_counts;
    const liveAfterBytes =
      Number(row.logical_bytes) -
      (countsLive ? Number(row.current_bytes) : 0) +
      (countsLive ? replacementBytes : 0);
    if (liveAfterBytes > this.quotaBytes) throw new RegistryAssetQuotaExceeded();
  }

  async put(principal: AssetPrincipal, data: BinaryBlob, meta?: AssetMeta): Promise<AssetId> {
    this.assertByteWriteIsCoordinatable();
    const storedMeta = meta ?? {};
    const encodedMeta = encodeMeta(storedMeta);
    const mime = storedMeta.contentType ?? data.type;
    const { contentHash, bytes: buffer } = await contentHashOf(data);
    const bytes = byteView(buffer);
    let id: AssetId;
    try {
      id = newAssetId();
    } catch {
      throw registryFailure('put');
    }

    if (this.stagesByteWrites()) {
      // Refuse an over-quota write before uploading anything. Not
      // authoritative -- the allocating transaction checks again under the
      // principal's lock -- only a way not to spend an upload on a write that
      // is going to be refused.
      try {
        await this.assertPutQuota(this.queryable, principal, bytes.byteLength, false);
      } catch (error) {
        if (error instanceof RegistryAssetQuotaExceeded) throw new AssetQuotaExceededError();
        throw registryFailure('put');
      }
      let record: StagedRecord;
      try {
        // The principal's lock ahead of the blob row, in the order the
        // allocation takes them (see `stage`).
        record = await this.stage(contentHash, bytes, data.type, (queryable) =>
          this.quotaBytes === undefined
            ? Promise.resolve()
            : this.lockPrincipal(queryable, principal),
        );
      } catch {
        throw registryFailure('put');
      }
      try {
        await this.allocateStaged(principal, id, record, mime, encodedMeta);
      } catch (error) {
        await this.releaseStage(record.stageId);
        throw error;
      }
      return id;
    }

    try {
      await this.writeTransaction(async (queryable) => {
        // Inside the transaction, and before anything is written: a check on
        // the pool is already stale when it is acted on.
        await this.assertPutQuota(queryable, principal, bytes.byteLength);
        await this.claimBlobRow(queryable, contentHash, bytes.byteLength);
        // Bytes are written only after the claim above has taken the blob
        // row's lock. Writing before it instead would not be safe: the
        // collector can hold that lock, delete those bytes, and commit while
        // this upsert waits, leaving a fresh entry pointing at nothing. The
        // write is unconditional, so both existence paths still emit the same
        // sequence. The entry is inserted after it, so no row ever references
        // bytes that were not stored first.
        await this.coordinatedWrite(queryable, contentHash, bytes);
        await this.insertPendingEntry(queryable, id, principal, contentHash, mime, encodedMeta);
      });
    } catch (error) {
      if (error instanceof RegistryAssetQuotaExceeded) throw new AssetQuotaExceededError();
      throw registryFailure('put');
    }
    return id;
  }

  /**
   * Read which bytes an entry names, under the shared blob-row lock so the
   * hash, label and revision come from one snapshot.
   */
  private async readEntryHash(
    queryable: Queryable,
    principal: AssetPrincipal,
    ref: AssetRef,
  ): Promise<{ hash: ContentHash; mime: string; revision: number } | null> {
    const result = await queryable.query<EntryRow>(
      `SELECT content_hash, mime, revision
         FROM asset_entries
        WHERE id = $1 AND principal = $2`,
      [ref, principal.key],
    );
    const entry = result.rows[0];
    if (!entry) return null;
    const locked = await queryable.query(
      `SELECT 1
         FROM asset_blobs
        WHERE content_hash = $1
        FOR SHARE`,
      [entry.content_hash],
    );
    if (!locked.rows[0]) return null;
    return { hash: entry.content_hash, mime: entry.mime, revision: Number(entry.revision) };
  }

  /**
   * Read an entry's bytes.
   *
   * A byte layer that joins the transaction (`readWith`) reads inside it, under
   * the shared blob-row lock. Any other layer -- an object store, where the
   * read is a network fetch of the whole object -- is read after the registry
   * transaction has committed, so no connection or lock is held across it. The
   * hash is content-addressed, so what it names cannot change in between; if
   * the bytes were reclaimed meanwhile (the entry was removed and its blob
   * collected), the layer reports a miss and this answers `null`, as it would
   * for a read that started after the removal.
   */
  async resolve(principal: AssetPrincipal, ref: AssetRef): Promise<AssetBytes | null> {
    if (!isLosslessJsonString(ref) || !isLosslessJsonString(principal.key)) return null;
    const store = this.byteStore;
    if (hasTransactionalReader(store)) {
      try {
        return await this.transaction(async (queryable) => {
          const read = await this.readEntryHash(queryable, principal, ref);
          if (read === null) return null;
          const bytes = await store.readWith(queryable, read.hash);
          if (bytes === null) return null;
          return { bytes, mime: read.mime, revision: read.revision };
        });
      } catch {
        throw registryFailure('resolve');
      }
    }
    try {
      const read = await this.transaction((queryable) =>
        this.readEntryHash(queryable, principal, ref),
      );
      if (read === null) return null;
      const bytes = await store.read(read.hash);
      if (bytes === null) return null;
      return { bytes, mime: read.mime, revision: read.revision };
    } catch {
      throw registryFailure('resolve');
    }
  }

  /**
   * The indirect counterpart of {@link resolve}: same ownership-checked read,
   * but the answer is a signed URL minted by the byte layer rather than the
   * bytes. Returns `undefined` when the byte layer cannot sign, so the caller
   * falls back to a direct read -- a byte column never gains a signer, and an
   * object store only declines when its signing dependency is absent.
   *
   * No byte is read here, which is the point: the network cost of an
   * object-store read moves off this path entirely. The shared blob-row lock
   * is still taken for the read, keeping the hash being signed in the same
   * snapshot as the entry that named it; the signing itself runs after the
   * transaction closes, since credential resolution can wait on the network.
   */
  async resolveIndirect(
    principal: AssetPrincipal,
    ref: AssetRef,
    request: AssetIndirectReadRequest,
  ): Promise<AssetIndirectRead | null | undefined> {
    const signReadUrl = this.byteStore.signReadUrl;
    if (typeof signReadUrl !== 'function') return undefined;
    if (!isLosslessJsonString(ref) || !isLosslessJsonString(principal.key)) return null;
    // The coordinated read and the signing are deliberately separate steps.
    // The read takes the shared blob-row lock so the hash, label and revision
    // come from one snapshot; the signing happens after the transaction has
    // closed, because a signer on refreshable credentials can wait on the
    // network, and no database connection or lock may be held across that.
    // What the URL names is already fixed by then, so signing cannot observe
    // anything the read did not.
    let read: { hash: ContentHash; mime: string; revision: number } | null;
    try {
      read = await this.transaction((queryable) => this.readEntryHash(queryable, principal, ref));
    } catch {
      throw registryFailure('resolve');
    }
    if (read === null) return null;
    let url: string | undefined;
    try {
      url = await signReadUrl.call(this.byteStore, read.hash, {
        ...request.label(read.mime),
        cacheControl: request.cacheControl,
        expiresInSeconds: request.expiresInSeconds,
      });
    } catch {
      throw registryFailure('resolve');
    }
    return url === undefined ? undefined : { url, revision: read.revision };
  }

  async identify(principal: AssetPrincipal, ref: AssetRef): Promise<AssetIdentity | null> {
    if (!isLosslessJsonString(ref) || !isLosslessJsonString(principal.key)) return null;
    try {
      const result = await this.queryable.query<IdentityRow>(
        `SELECT entries.mime, entries.revision, blobs.byte_size
           FROM asset_entries AS entries
           JOIN asset_blobs AS blobs ON blobs.content_hash = entries.content_hash
          WHERE entries.id = $1 AND entries.principal = $2`,
        [ref, principal.key],
      );
      const identity = result.rows[0];
      if (!identity) return null;
      return {
        mime: identity.mime,
        revision: Number(identity.revision),
        byteLength: Number(identity.byte_size),
      };
    } catch {
      throw registryFailure('identify');
    }
  }

  /**
   * Delete one entry, and stamp the blob when no entry names it any more.
   *
   * An entry a reference root holds is refused with {@link AssetRootedError}
   * and left as it is: the root belongs to a record this package does not
   * interpret, which withdraws the root itself before the asset may go. The
   * check runs under the entry's row lock, in a statement of its own (see
   * {@link entryIsRooted}).
   *
   * Any `document_asset_refs` rows naming this id go with the row through that
   * table's `ON DELETE CASCADE`, which needs no statement here. An unknown id
   * -- or another principal's id -- is the same no-op, because it locks and
   * deletes no row.
   */
  async remove(principal: AssetPrincipal, ref: AssetRef): Promise<void> {
    if (!isLosslessJsonString(ref) || !isLosslessJsonString(principal.key)) return;
    try {
      await this.writeTransaction(async (queryable) => {
        const locked = await queryable.query<{ id: string }>(
          `SELECT id FROM asset_entries
            WHERE id = $1 AND principal = $2
            FOR UPDATE`,
          [ref, principal.key],
        );
        if (!locked.rows[0]) return;
        if (await entryIsRooted(queryable, ref)) throw new AssetRootedError();
        const deleted = await queryable.query<HashRow>(
          `DELETE FROM asset_entries
            WHERE id = $1 AND principal = $2
            RETURNING content_hash`,
          [ref, principal.key],
        );
        const hash = deleted.rows[0]?.content_hash;
        if (!hash) return;
        await queryable.query(
          `UPDATE asset_blobs
              SET unreferenced_at = now()
            WHERE content_hash = $1
              AND NOT EXISTS (
                SELECT 1 FROM asset_entries WHERE content_hash = $1
              )`,
          [hash],
        );
      });
    } catch (error) {
      if (error instanceof AssetRootedError) throw error;
      throw registryFailure('remove');
    }
  }

  /**
   * Delete one entry only while it is still an unclaimed allocation: this
   * principal's, still pending (no document write has committed it, and its
   * deadline stands), and named by no document. Answers whether it deleted.
   *
   * For a writer that allocated ids and then failed to write the document
   * that would name them: releasing them at once keeps a retry from holding
   * two copies. The guard is what makes that safe when the writer cannot be
   * sure its write failed (a lost COMMIT acknowledgement): an entry the
   * document did commit is no longer pending, and one it references has a
   * reference row, so neither is touched. The blob is stamped like
   * {@link remove} does when no entry names it any more.
   */
  async releasePending(principal: AssetPrincipal, ref: AssetRef): Promise<boolean> {
    if (!isLosslessJsonString(ref) || !isLosslessJsonString(principal.key)) return false;
    try {
      return await this.writeTransaction(async (queryable) => {
        // TWO statements, for the reason the collector's entry pass gives
        // (`AssetCollector.releaseEntries`). The first locks the entry while
        // it is still this principal's pending allocation; a document write
        // racing it updates the row, so a lock wait re-evaluates the pending
        // predicate against the new row and skips it. The reference check has
        // to be a separate statement: a reference-only writer (the backfill)
        // inserts into `document_asset_refs` under `KEY SHARE` without
        // updating the entry, so a `NOT EXISTS` folded into the locking or
        // deleting statement would keep its statement-start answer ("no
        // reference") after waiting on that writer, and the delete would
        // cascade its committed reference away. Under READ COMMITTED the
        // second statement takes a fresh snapshot and sees it, and the
        // `FOR UPDATE` held since keeps any later reference insert waiting
        // until this transaction ends.
        const locked = await queryable.query<HashRow>(
          `SELECT content_hash
             FROM asset_entries
            WHERE id = $1 AND principal = $2
              AND committed_at IS NULL AND expires_at IS NOT NULL
            FOR UPDATE`,
          [ref, principal.key],
        );
        const hash = locked.rows[0]?.content_hash;
        if (!hash) return false;
        const referenced = await queryable.query(
          'SELECT 1 FROM document_asset_refs WHERE asset_id = $1 LIMIT 1',
          [ref],
        );
        if (referenced.rows.length > 0) return false;
        await queryable.query('DELETE FROM asset_entries WHERE id = $1', [ref]);
        await queryable.query(
          `UPDATE asset_blobs
              SET unreferenced_at = now()
            WHERE content_hash = $1
              AND NOT EXISTS (
                SELECT 1 FROM asset_entries WHERE content_hash = $1
              )`,
          [hash],
        );
        return true;
      });
    } catch {
      throw registryFailure('releasePending');
    }
  }

  async replace(
    principal: AssetPrincipal,
    ref: AssetId,
    data: BinaryBlob,
    meta?: AssetMeta,
  ): Promise<number> {
    if (!isLosslessJsonString(ref) || !isLosslessJsonString(principal.key)) {
      throw new AssetNotFoundError();
    }
    const storedMeta = meta === undefined ? undefined : meta;
    const encodedMeta = storedMeta === undefined ? undefined : encodeMeta(storedMeta);
    const replacementMime = storedMeta?.contentType ?? data.type;
    const { contentHash, bytes: buffer } = await contentHashOf(data);
    const bytes = byteView(buffer);
    this.assertByteWriteIsCoordinatable();

    let staged: StagedRecord | undefined;
    if (this.stagesByteWrites()) {
      // The refusals `replace` can answer without writing, checked before the
      // upload so a refused replace does not spend one. Not authoritative: the
      // replacing transaction below checks all of them again under its locks.
      try {
        await this.assertReplaceQuota(this.queryable, principal, ref, bytes.byteLength, false);
        const exists = await this.queryable.query(
          'SELECT 1 FROM asset_entries WHERE id = $1 AND principal = $2',
          [ref, principal.key],
        );
        if (!exists.rows[0]) throw new RegistryAssetNotFound();
        if (await entryIsRooted(this.queryable, ref)) throw new AssetRootedError();
        // The principal's lock, then the entry's, ahead of the blob row: the
        // order the replacing transaction below takes them (see `stage`).
        staged = await this.stage(contentHash, bytes, data.type, async (queryable) => {
          if (this.quotaBytes !== undefined) await this.lockPrincipal(queryable, principal);
          await queryable.query(
            'SELECT id FROM asset_entries WHERE id = $1 AND principal = $2 FOR UPDATE',
            [ref, principal.key],
          );
        });
      } catch (error) {
        throw replaceFailure(error);
      }
    }
    const claim = (queryable: Queryable): Promise<void> =>
      staged === undefined
        ? this.claimBlobRow(queryable, contentHash, bytes.byteLength).then(() =>
            this.coordinatedWrite(queryable, contentHash, bytes),
          )
        : this.claimStagedBlob(queryable, staged);

    try {
      return await this.writeTransaction(async (queryable) => {
        await this.assertReplaceQuota(queryable, principal, ref, bytes.byteLength);
        const existing = await queryable.query<EntryRow>(
          `SELECT content_hash, mime, meta, revision
             FROM asset_entries
            WHERE id = $1 AND principal = $2
            FOR UPDATE`,
          [ref, principal.key],
        );
        const oldEntry = existing.rows[0];
        if (!oldEntry) throw new RegistryAssetNotFound();
        // Under the entry lock, in a statement of its own: see `entryIsRooted`.
        // The quota check above stays ahead of the lock (it takes the
        // principal's lock first, the order `reassignPrincipal` relies on), so
        // a rooted entry whose replacement would also exceed the quota reports
        // the quota; either way nothing is written.
        if (await entryIsRooted(queryable, ref)) throw new AssetRootedError();

        // Claim the new blob row, then write its bytes through the
        // transaction -- or, for a staged write, spend the pin of the bytes
        // already uploaded (see `claimStagedBlob`).
        await claim(queryable);

        // The lifecycle columns are deliberately absent from both branches
        // below: replacing bytes under an existing id changes neither what
        // names that id nor when it was first named, so a pending entry stays
        // pending and an unreferenced one stays unreferenced.
        let updated;
        if (storedMeta === undefined) {
          updated = await queryable.query<{ revision: number | string }>(
            `UPDATE asset_entries
                SET content_hash = $3,
                    mime = CASE WHEN $4 = '' THEN mime ELSE $4 END,
                    revision = revision + 1
              WHERE id = $1 AND principal = $2
              RETURNING revision`,
            [ref, principal.key, contentHash, data.type],
          );
        } else {
          updated = await queryable.query<{ revision: number | string }>(
            `UPDATE asset_entries
                SET content_hash = $3,
                    mime = $4,
                    meta = $5::jsonb,
                    revision = revision + 1
              WHERE id = $1 AND principal = $2
              RETURNING revision`,
            [ref, principal.key, contentHash, replacementMime, encodedMeta],
          );
        }

        await queryable.query(
          `UPDATE asset_blobs
              SET unreferenced_at = now()
            WHERE content_hash = $1
              AND NOT EXISTS (
                SELECT 1 FROM asset_entries WHERE content_hash = $1
              )`,
          [oldEntry.content_hash],
        );
        return Number(updated.rows[0]!.revision);
      });
    } catch (error) {
      if (staged !== undefined) await this.releaseStage(staged.stageId);
      throw replaceFailure(error);
    }
  }

  /**
   * Move every entry held by principal `fromKey` to principal `toKey`: the
   * re-key half of merging two owners' asset partitions. Answers how many
   * entries moved.
   *
   * Nothing else about an entry changes -- its id, bytes, lifecycle columns
   * and the document references naming it stay as they are -- so a document
   * that renders the entry keeps rendering it, provided whatever decides who
   * may read an entry (a host's read rule) agrees about the new principal.
   *
   * Both principals' write locks (the advisory lock `put` and `replace` take
   * under a quota) are taken first, in key order, so the move cannot
   * interleave with a quota check for either side. The quota itself is not
   * checked: a merge never drops an entry, so the target may end up above its
   * quota, and its next `put` is refused until it is back under.
   *
   * Runs in the store's write transaction; pin the store to an open
   * transaction to make it part of a larger one.
   */
  async reassignPrincipal(fromKey: string, toKey: string): Promise<number> {
    if (
      typeof fromKey !== 'string' ||
      fromKey === '' ||
      typeof toKey !== 'string' ||
      toKey === '' ||
      !isLosslessJsonString(fromKey) ||
      !isLosslessJsonString(toKey)
    ) {
      throw new Error('@openmaic/storage: asset principal keys must be non-empty text');
    }
    if (fromKey === toKey) return 0;
    return this.writeTransaction(async (queryable) => {
      const keys = await queryable.query<{ key: string }>(
        `SELECT DISTINCT hashtextextended(principal, 0)::text AS key
           FROM unnest($1::text[]) AS principal`,
        [[fromKey, toKey]],
      );
      const ordered = keys.rows
        .map((row) => BigInt(row.key))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const key of ordered) {
        await queryable.query('SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()]);
      }
      // Row locks in id order, the order the collector's passes walk entries
      // in, before the update touches them.
      await queryable.query(
        `SELECT id FROM asset_entries WHERE principal = $1 ORDER BY id FOR UPDATE`,
        [fromKey],
      );
      const moved = await queryable.query<{ id: string }>(
        `UPDATE asset_entries SET principal = $2 WHERE principal = $1 RETURNING id`,
        [fromKey, toKey],
      );
      return moved.rows.length;
    });
  }
}
