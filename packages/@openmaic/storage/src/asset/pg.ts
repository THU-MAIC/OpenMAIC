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
  type AssetBytes,
  type AssetIdentity,
  type AssetIndirectRead,
  type AssetIndirectReadRequest,
  type AssetPrincipal,
  type AssetStore,
} from './types.js';
import { assertJsonValue, isLosslessJsonString } from '../runtime/json-value.js';
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
export { AssetNotFoundError, AssetQuotaExceededError } from './types.js';

export interface PgAssetStoreOptions {
  /** Pin each callback to a fresh PostgreSQL transaction and connection. */
  withTransaction: WithTransaction;
  /** Physical byte storage used beneath the registry. */
  byteStore: AssetByteStore;
  /** Optional logical-byte ceiling for each principal. */
  quotaBytes?: number;
}

/** One PGlite-compatible statement per entry, in dependency order. */
export const ASSET_PG_SCHEMA: readonly string[] = [
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
];

export async function ensureAssetSchema(queryable: Queryable): Promise<void> {
  for (const statement of ASSET_PG_SCHEMA) await queryable.query(statement);
}

interface UsageRow extends Record<string, unknown> {
  logical_bytes: number | string;
}

interface ReplaceUsageRow extends UsageRow {
  current_bytes: number | string;
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

function registryFailure(operation: string): Error {
  return new Error(`@openmaic/storage: asset registry ${operation} failed`);
}

class RegistryAssetNotFound extends Error {}

class RegistryAssetQuotaExceeded extends Error {}

function encodeMeta(meta: AssetMeta): string {
  assertJsonValue(meta, 'asset metadata');
  try {
    const encoded = JSON.stringify(meta);
    if (encoded === undefined) throw new TypeError('not serializable');
    return encoded;
  } catch {
    throw new Error('@openmaic/storage: asset metadata is not JSON-serializable');
  }
}

function byteView(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

export class PgAssetStore implements AssetStore {
  private readonly transactionHook: WithTransaction;
  private readonly byteStore: AssetByteStore;
  private readonly quotaBytes?: number;

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
    this.transactionHook = options.withTransaction;
    this.byteStore = options.byteStore;
    this.quotaBytes = options.quotaBytes;
  }

  private transaction<T>(body: (queryable: Queryable) => Promise<T>): Promise<T> {
    return this.transactionHook(body);
  }

  private async coordinatedWrite(
    queryable: Queryable,
    hash: ContentHash,
    bytes: Uint8Array,
  ): Promise<void> {
    if (hasTransactionalWriter(this.byteStore)) {
      await this.byteStore.writeWith(queryable, hash, bytes);
    } else {
      await this.byteStore.write(hash, bytes);
    }
  }

  private readBytes(queryable: Queryable, hash: ContentHash): Promise<Uint8Array | null> {
    return hasTransactionalReader(this.byteStore)
      ? this.byteStore.readWith(queryable, hash)
      : this.byteStore.read(hash);
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
    // would block each other for the whole transaction -- which spans a byte
    // write that may be a network upload.
    await queryable.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [principal.key]);
  }

  private async assertPutQuota(
    queryable: Queryable,
    principal: AssetPrincipal,
    addedBytes: number,
  ): Promise<void> {
    if (this.quotaBytes === undefined) return;
    await this.lockPrincipal(queryable, principal);
    let result;
    try {
      result = await queryable.query<UsageRow>(
        `SELECT COALESCE(SUM(blobs.byte_size), 0)::text AS logical_bytes
           FROM asset_entries AS entries
           JOIN asset_blobs AS blobs ON blobs.content_hash = entries.content_hash
          WHERE entries.principal = $1`,
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
  ): Promise<void> {
    if (this.quotaBytes === undefined) return;
    await this.lockPrincipal(queryable, principal);
    let result;
    try {
      result = await queryable.query<ReplaceUsageRow>(
        `SELECT current_blob.byte_size::text AS current_bytes,
                usage.logical_bytes
           FROM asset_entries AS current_entry
           JOIN asset_blobs AS current_blob
             ON current_blob.content_hash = current_entry.content_hash
           CROSS JOIN (
             SELECT COALESCE(SUM(blobs.byte_size), 0)::text AS logical_bytes
               FROM asset_entries AS entries
               JOIN asset_blobs AS blobs ON blobs.content_hash = entries.content_hash
              WHERE entries.principal = $2
           ) AS usage
          WHERE current_entry.id = $1 AND current_entry.principal = $2`,
        [ref, principal.key],
      );
    } catch {
      throw registryFailure('quota check');
    }
    const row = result.rows[0];
    if (!row) throw new RegistryAssetNotFound();
    if (
      Number(row.logical_bytes) - Number(row.current_bytes) + replacementBytes >
      this.quotaBytes
    ) {
      throw new RegistryAssetQuotaExceeded();
    }
  }

  async put(principal: AssetPrincipal, data: BinaryBlob, meta?: AssetMeta): Promise<AssetId> {
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

    try {
      await this.transaction(async (queryable) => {
        // Inside the transaction, and before anything is written: a check on
        // the pool is already stale when it is acted on.
        await this.assertPutQuota(queryable, principal, bytes.byteLength);
        await queryable.query(
          `INSERT INTO asset_blobs (content_hash, byte_size, unreferenced_at)
           VALUES ($1, $2, NULL)
           ON CONFLICT (content_hash) DO UPDATE
             SET unreferenced_at = NULL,
                 byte_size = EXCLUDED.byte_size`,
          [contentHash, bytes.byteLength],
        );
        // Bytes are written only after the upsert above has taken the blob
        // row's lock. Writing before it instead would not be safe: the
        // collector can hold that lock, delete those bytes, and commit while
        // this upsert waits, leaving a fresh entry pointing at nothing. The
        // write is unconditional, so both existence paths still emit the same
        // sequence. The entry is inserted after it, so no row ever references
        // bytes that were not stored first.
        await this.coordinatedWrite(queryable, contentHash, bytes);
        await queryable.query(
          `INSERT INTO asset_entries
             (id, principal, content_hash, mime, meta, revision, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, 1, $6)`,
          [id, principal.key, contentHash, mime, encodedMeta, Date.now()],
        );
      });
    } catch (error) {
      if (error instanceof RegistryAssetQuotaExceeded) throw new AssetQuotaExceededError();
      throw registryFailure('put');
    }
    return id;
  }

  async resolve(principal: AssetPrincipal, ref: AssetRef): Promise<AssetBytes | null> {
    if (!isLosslessJsonString(ref) || !isLosslessJsonString(principal.key)) return null;
    try {
      return await this.transaction(async (queryable) => {
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
        const bytes = await this.readBytes(queryable, entry.content_hash);
        if (bytes === null) return null;
        return { bytes, mime: entry.mime, revision: Number(entry.revision) };
      });
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
      read = await this.transaction(async (queryable) => {
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
        return {
          hash: entry.content_hash,
          mime: entry.mime,
          revision: Number(entry.revision),
        };
      });
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

  async remove(principal: AssetPrincipal, ref: AssetRef): Promise<void> {
    if (!isLosslessJsonString(ref) || !isLosslessJsonString(principal.key)) return;
    try {
      await this.transaction(async (queryable) => {
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
    } catch {
      throw registryFailure('remove');
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
    try {
      return await this.transaction(async (queryable) => {
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

        await queryable.query(
          `INSERT INTO asset_blobs (content_hash, byte_size, unreferenced_at)
           VALUES ($1, $2, NULL)
           ON CONFLICT (content_hash) DO UPDATE
             SET unreferenced_at = NULL,
                 byte_size = EXCLUDED.byte_size`,
          [contentHash, bytes.byteLength],
        );
        await this.coordinatedWrite(queryable, contentHash, bytes);

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
      if (error instanceof RegistryAssetNotFound) throw new AssetNotFoundError();
      if (error instanceof RegistryAssetQuotaExceeded) throw new AssetQuotaExceededError();
      throw registryFailure('replace');
    }
  }
}
