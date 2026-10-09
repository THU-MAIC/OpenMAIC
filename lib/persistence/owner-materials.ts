/**
 * Owner-scoped material library — the server-side half of `POST /api/materials`
 * (the reference's `lib/server/materials/store.ts`, ported onto this branch's
 * server provider with raw SQL, the same pattern as `stage-meta.ts`).
 *
 * The workbench's material uploader (`uploadWorkbenchMaterial`) is owner-
 * scoped: it posts a file with no session id and expects a flat 201 view. The
 * branch's agent-session materials stay session-scoped (the agent tools' list
 * surface); this table is the owner's durable library that the uploader feeds.
 *
 * An upload's bytes live in the asset pool, under the owner's own partition:
 * the row's `asset_id` points at the entry and a `('material', id)` reference
 * root keeps it alive. Rows from before the pool hold a private object key in
 * the material byte store (`oss_key`) instead, until the backfill moves them;
 * readers take the pool pointer first.
 *
 * ## Upload lifecycle
 *
 * An upload reserves a row with `status = 'uploading'` (quota-checked against
 * the owner's active source materials, `oss_key = ''`), reads its body through
 * a sha256 meter, allocates a pending pool entry for the bytes
 * ({@link allocateOwnerMaterialBytes}), then publishes the pointer, the root
 * and `'ready'` in one transaction ({@link publishOwnerMaterialUpload}). A
 * failed upload abandons the row and leaves any pending entry to expire; a
 * process death leaves `uploading` rows behind, which the next upload's 24-hour
 * reclaim removes. Rows reserved before the pool still name an object, which
 * the reclaim deletes first, then the reservation, so a crash mid-reclaim never
 * loses the pointer to the bytes.
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';
import { encodeJson } from '@openmaic/storage/pg-json';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import type { BinaryBlob } from '@openmaic/dsl';
import type { WithTransaction } from '@openmaic/storage/document/pg';
import type { AssetStore } from '@openmaic/storage';

import { MATERIAL_ROOT_KIND, withMaterialRoots } from './material-roots';
import { statusJson } from './owner-material-extraction';
import { assetPrincipalForOwner } from './owner-assets';
import { ensureOwnerMergeSchema, fenceOwnerWrite } from './owner-merges';

export const OWNER_MATERIAL_STATUSES = ['uploading', 'ready'] as const;
export type OwnerMaterialStatus = (typeof OWNER_MATERIAL_STATUSES)[number];

/** `image` rows are extraction derivatives of a source (`derivedFrom`). */
export const OWNER_MATERIAL_KINDS = ['source', 'web', 'image'] as const;
export type OwnerMaterialKind = (typeof OWNER_MATERIAL_KINDS)[number];

export interface OwnerMaterialExtraction {
  status: 'idle' | 'pending' | 'running' | 'done' | 'failed';
  [key: string]: unknown;
}

export interface OwnerMaterialRecord {
  id: string;
  ownerId: string;
  kind: OwnerMaterialKind;
  derivedFrom: string | null;
  mime: string | null;
  bytes: number;
  originalName: string | null;
  /** Private material-byte-store object key of a pre-pool row; `''` once in the pool or never stored. */
  ossKey: string;
  /** The asset pool entry holding the original, or `null` for a row not in the pool. */
  assetId: string | null;
  /** Null only while status=uploading; finalized ready rows always carry a digest. */
  sha256: string | null;
  status: OwnerMaterialStatus;
  extraction: OwnerMaterialExtraction | null;
  createdAt: number;
  deletedAt: number | null;
}

/** The flat view the uploader's client contract reads (the reference's `publicMaterial`). */
export interface OwnerMaterialView {
  materialId: string;
  kind: OwnerMaterialKind;
  derivedFrom?: string;
  mime?: string;
  bytes: number;
  originalName?: string;
  extraction?: OwnerMaterialExtraction;
  createdAt: string;
}

export class MaterialQuotaExceededError extends Error {
  constructor(
    readonly quota: 'count' | 'bytes',
    readonly maximum: number,
  ) {
    super(
      quota === 'count'
        ? `material count quota exceeded (maximum ${maximum})`
        : `material byte quota exceeded (maximum ${maximum} bytes)`,
    );
    this.name = 'MaterialQuotaExceededError';
  }
}

export interface OwnerMaterialRegistrationLimits {
  maxCount: number;
  maxTotalBytes: number;
}

export interface RegisterOwnerMaterialInput {
  id: string;
  ownerId: string;
  kind: OwnerMaterialKind;
  derivedFrom?: string;
  mime?: string;
  bytes: number;
  originalName?: string;
  ossKey: string;
  extraction?: OwnerMaterialExtraction;
}

export const OWNER_MATERIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS owner_material (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  derived_from TEXT,
  mime TEXT,
  bytes DOUBLE PRECISION NOT NULL,
  original_name TEXT,
  oss_key TEXT NOT NULL,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  extraction JSONB,
  created_at DOUBLE PRECISION NOT NULL,
  deleted_at DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS owner_material_owner_created_idx
  ON owner_material (owner_id, created_at);

-- Databases created before the byte-store model have this table without
-- oss_key (they tracked an asset id instead); CREATE TABLE IF NOT EXISTS
-- leaves such tables untouched, so the column must be added here. The ''
-- default is the existing "no bytes recorded" sentinel the stale-upload
-- sweeper already understands.
ALTER TABLE owner_material ADD COLUMN IF NOT EXISTS oss_key TEXT NOT NULL DEFAULT '';

-- asset_id is the material's pointer into the asset pool. A table created
-- before the byte-store model still carries an older asset_id column: NOT
-- NULL, which would reject every insert of the current row shape, and holding
-- ids from the retired registry wiring, which must never be read as pool
-- pointers. Both are undone together in ONE statement, so a failure part-way
-- can never leave the column nullable with the old values still in it (a
-- state the next bootstrap would no longer recognize): the bootstrap lock is
-- session-scoped and opens no transaction, and each statement here may run on
-- its own pooled connection. Once the column is nullable this block does
-- nothing. The old values carry nothing a reader needs; the DROP this
-- replaces discarded them too.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'owner_material'
       AND column_name = 'asset_id'
       AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE owner_material ALTER COLUMN asset_id DROP NOT NULL;
    UPDATE owner_material SET asset_id = NULL;
  END IF;
END
$$;

-- Library columns. All nullable: a process that predates them still inserts
-- rows without them. asset_id is the pool pointer uploads publish and readers
-- take first; folder_id files a material (NULL is Unfiled) and display_name
-- is the name it was renamed to (./material-library.ts).
ALTER TABLE owner_material ADD COLUMN IF NOT EXISTS asset_id TEXT;
ALTER TABLE owner_material ADD COLUMN IF NOT EXISTS folder_id TEXT;
ALTER TABLE owner_material ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Owner-level extraction (./owner-material-extraction.ts). The status stays in
-- the existing extraction JSONB, the one value the public view already
-- shows; everything below is private bookkeeping the view never selects.
-- Nullable or defaulted, so a process that predates them still inserts.
-- extraction_token names the current claim; every claim gets a fresh one,
-- so a superseded worker can never be mistaken for the current one.
-- extraction_claims counts claims since the last explicit start (the
-- budget); extraction_lease_at is the claim's last heartbeat in epoch ms.
-- extraction_result is the latest successful extraction, its revision
-- included; extraction_cache_key is what another source of the same owner
-- looks it up by.
ALTER TABLE owner_material ADD COLUMN IF NOT EXISTS extraction_token TEXT;
ALTER TABLE owner_material ADD COLUMN IF NOT EXISTS extraction_claims INTEGER NOT NULL DEFAULT 0;
ALTER TABLE owner_material ADD COLUMN IF NOT EXISTS extraction_lease_at DOUBLE PRECISION;
ALTER TABLE owner_material ADD COLUMN IF NOT EXISTS extraction_error TEXT;
ALTER TABLE owner_material ADD COLUMN IF NOT EXISTS extraction_result JSONB;
ALTER TABLE owner_material ADD COLUMN IF NOT EXISTS extraction_cache_key TEXT;

CREATE INDEX IF NOT EXISTS owner_material_extraction_queue_idx
  ON owner_material (created_at)
  WHERE kind = 'source' AND (extraction->>'status') IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS owner_material_extraction_cache_idx
  ON owner_material (owner_id, extraction_cache_key)
  WHERE extraction_cache_key IS NOT NULL;

-- A source's derivatives: what a conversation's link reaches, and what moving
-- or deleting a source must take along.
CREATE INDEX IF NOT EXISTS owner_material_derived_from_idx
  ON owner_material (derived_from)
  WHERE derived_from IS NOT NULL;

-- A folder's materials: listing and counting by folder, and the check the
-- folder foreign key's ON DELETE RESTRICT runs when a folder is deleted,
-- which would otherwise scan every owner's materials.
CREATE INDEX IF NOT EXISTS owner_material_owner_folder_idx
  ON owner_material (owner_id, folder_id)
  WHERE folder_id IS NOT NULL;

-- Flat, owner-scoped material folders. Unfiled is folder_id IS NULL, not a
-- row. Names are unique per owner by their normalized form, as course folders
-- are.
CREATE TABLE IF NOT EXISTS material_folders (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, normalized_name)
);

-- A material may only be filed in a folder of its own owner, and a folder
-- that still holds a material cannot be deleted. ADD CONSTRAINT has no IF NOT
-- EXISTS, hence the guard. A NULL folder_id is not checked (MATCH SIMPLE).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'owner_material_folder_fk'
       AND conrelid = 'owner_material'::regclass
  ) THEN
    ALTER TABLE owner_material
      ADD CONSTRAINT owner_material_folder_fk
      FOREIGN KEY (owner_id, folder_id)
      REFERENCES material_folders (owner_id, id)
      ON DELETE RESTRICT;
  END IF;
END
$$;
`;

export async function ensureOwnerMaterialSchema(queryable: Queryable): Promise<void> {
  // splitSqlStatements skips `--` line comments (and quoted strings), so a
  // semicolon in the migration's prose can never split a statement mid-text
  // the way a plain `split(';')` does.
  for (const statement of splitSqlStatements(OWNER_MATERIAL_SCHEMA)) {
    await queryable.query(statement);
  }
  // Registration fences on the claim records (./owner-merges.ts).
  await ensureOwnerMergeSchema(queryable);
}

export interface RawOwnerMaterialRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  kind: string;
  derived_from: string | null;
  mime: string | null;
  bytes: number | string;
  original_name: string | null;
  oss_key: string;
  asset_id: string | null;
  sha256: string | null;
  status: string;
  extraction: unknown;
  created_at: number | string;
  deleted_at: number | string | null;
}

/** The columns {@link ownerMaterialRowToRecord} reads, in `SELECT` order. */
export const OWNER_MATERIAL_COLUMNS = `id,
  owner_id,
  kind,
  derived_from,
  mime,
  bytes,
  original_name,
  oss_key,
  asset_id,
  sha256,
  status,
  extraction,
  created_at,
  deleted_at`;

export function ownerMaterialRowToRecord(row: RawOwnerMaterialRow): OwnerMaterialRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind as OwnerMaterialKind,
    derivedFrom: row.derived_from,
    mime: row.mime,
    bytes: Number(row.bytes),
    originalName: row.original_name,
    ossKey: row.oss_key,
    assetId: row.asset_id,
    sha256: row.sha256,
    status: row.status as OwnerMaterialStatus,
    extraction: extractionOf(row.extraction),
    createdAt: Number(row.created_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
  };
}

function extractionOf(raw: unknown): OwnerMaterialExtraction | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const status = value.status;
  if (
    status !== 'idle' &&
    status !== 'pending' &&
    status !== 'running' &&
    status !== 'done' &&
    status !== 'failed'
  ) {
    return null;
  }
  return value as unknown as OwnerMaterialExtraction;
}

export function publicMaterial(record: OwnerMaterialRecord): OwnerMaterialView {
  return {
    materialId: record.id,
    kind: record.kind,
    ...(record.derivedFrom ? { derivedFrom: record.derivedFrom } : {}),
    ...(record.mime ? { mime: record.mime } : {}),
    bytes: record.bytes,
    ...(record.originalName ? { originalName: record.originalName } : {}),
    ...(record.extraction ? { extraction: record.extraction } : {}),
    createdAt: new Date(record.createdAt).toISOString(),
  };
}

const STALE_UPLOAD_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * Per-owner advisory-lock key that serializes quota reservations.
 *
 * The key namespaces the owner's id so two concurrent uploads for the same
 * owner queue behind the same transaction-scoped lock (see
 * {@link registerOwnerMaterial}). Reserving metadata and storing bytes are
 * separate operations; the lock protects the quota read-check-insert section.
 */
export function ownerMaterialQuotaLockKey(ownerId: string): string {
  return `owner-materials:${ownerId}:quota`;
}

/**
 * What the upload paths need of the server persistence provider: its pool, its
 * transactions, and the asset registry pinned to one of them.
 */
export interface OwnerMaterialPersistence {
  pool: Queryable;
  withTransaction: WithTransaction;
  assetStoreIn(queryable: Queryable): AssetStore;
}

/**
 * Reclaim uploads that crashed before they were published and are older than
 * the sweep horizon.
 *
 * Order is load-bearing for a reservation made before the asset pool, which
 * still names an object in the material byte store: that object is removed
 * first, and only then is the reservation deleted. Deleting the reservation
 * first would lose the pointer to its bytes on a crash between the two, so the
 * object would remain orphaned forever. A reservation whose byte deletion
 * throws is left in place (still quota-counted) and the next pass retries it.
 * A reservation made since names no object (`oss_key = ''`); the pending pool
 * entry its upload may have allocated expires on its own.
 *
 * Each reservation is then deleted as {@link abandonOwnerMaterial} deletes one.
 *
 * @param deleteBytes Reclaims one recorded object key; must resolve when the
 *   object is removed or confirmed already absent, and throw to keep the
 *   reservation for the next pass.
 */
export async function reclaimStaleOwnerMaterialUploads(
  persistence: Pick<OwnerMaterialPersistence, 'pool' | 'withTransaction'>,
  ownerId: string,
  deleteBytes: (ossKey: string) => Promise<void>,
): Promise<void> {
  const staleBefore = Date.now() - STALE_UPLOAD_AGE_MS;
  const stale = await persistence.pool.query<{ id: string; oss_key: string }>(
    `SELECT id, oss_key
       FROM owner_material
      WHERE owner_id = $1
        AND status = 'uploading'
        AND created_at < $2`,
    [ownerId, staleBefore],
  );
  for (const row of stale.rows) {
    if (row.oss_key !== '') {
      try {
        await deleteBytes(row.oss_key);
      } catch {
        // The byte object is not confirmed gone; keep the reservation so the
        // next pass retries with the pointer intact.
        continue;
      }
    }
    await deleteUploadingRow(persistence, ownerId, row.id);
  }
}

/**
 * Reserve one uploading row under the owner's quota.
 *
 * Runs in a transaction that takes a transaction-scoped advisory lock keyed on
 * the owner before the quota read. Under READ COMMITTED the aggregate quota
 * query alone locks no row, so without the lock two concurrent uploads could
 * both observe the same remaining slot or bytes and both insert, overshooting
 * the configured boundary; the lock makes the read-check-insert one critical
 * section per owner. Stale `uploading` rows from crashed uploads are reclaimed
 * by the caller via {@link reclaimStaleOwnerMaterialUploads} before this call.
 */
export async function registerOwnerMaterial(
  queryable: ConnectableQueryable,
  input: RegisterOwnerMaterialInput,
  limits: OwnerMaterialRegistrationLimits,
): Promise<OwnerMaterialRecord> {
  const withTransaction = nodePostgresTransaction(queryable);
  return withTransaction(async (tx) => {
    // The identity lock first, as every owner write takes it: a registration
    // racing a claim of this owner lands before the claim (and is moved) or
    // is refused -- see ./owner-merges.ts.
    await fenceOwnerWrite(tx, input.ownerId);
    // hashtextextended is 64-bit (hashtext is 32-bit and could block unrelated
    // owners on a collision); the lock is transaction-scoped and releases on
    // commit or rollback.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      ownerMaterialQuotaLockKey(input.ownerId),
    ]);

    const usage = await tx.query<{ count: number | string; total_bytes: number | string }>(
      `SELECT COUNT(*)::text AS count,
              COALESCE(SUM(bytes), 0)::text AS total_bytes
         FROM owner_material
        WHERE owner_id = $1 AND kind = 'source' AND deleted_at IS NULL`,
      [input.ownerId],
    );
    const count = Number(usage.rows[0]?.count ?? 0);
    const totalBytes = Number(usage.rows[0]?.total_bytes ?? 0);
    if (count >= limits.maxCount) {
      throw new MaterialQuotaExceededError('count', limits.maxCount);
    }
    if (totalBytes + input.bytes > limits.maxTotalBytes) {
      throw new MaterialQuotaExceededError('bytes', limits.maxTotalBytes);
    }

    const inserted = await tx.query<RawOwnerMaterialRow>(
      `INSERT INTO owner_material
         (id, owner_id, kind, derived_from, mime, bytes, original_name,
          oss_key, sha256, status, extraction, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, 'uploading', $9::jsonb, $10)
       RETURNING ${OWNER_MATERIAL_COLUMNS}`,
      [
        input.id,
        input.ownerId,
        input.kind,
        input.derivedFrom ?? null,
        input.mime ?? null,
        input.bytes,
        input.originalName ?? null,
        input.ossKey,
        input.extraction ? encodeJson(input.extraction, 'owner material extraction') : null,
        Date.now(),
      ],
    );
    return ownerMaterialRowToRecord(inserted.rows[0]);
  });
}

/**
 * Finalize a reservation whose bytes were stored in the material byte store:
 * the row shape uploads had before the asset pool (`oss_key`, no pointer, no
 * root). The upload route no longer calls it; it stays because tests build the
 * pre-pool rows the read path and the backfill must still handle with it.
 * Reserved bytes may only shrink.
 */
export async function finalizeOwnerMaterial(
  queryable: Queryable,
  materialId: string,
  bytes: number,
  sha256: string,
): Promise<OwnerMaterialRecord> {
  const result = await queryable.query<RawOwnerMaterialRow>(
    `UPDATE owner_material
        SET bytes = $2, sha256 = $3, status = 'ready'
      WHERE id = $1
        AND status = 'uploading'
        AND deleted_at IS NULL
        AND bytes >= $2
      RETURNING ${OWNER_MATERIAL_COLUMNS}`,
    [materialId, bytes, sha256],
  );
  if (!result.rows[0]) throw new Error(`material ${materialId} cannot be finalized`);
  return ownerMaterialRowToRecord(result.rows[0]);
}

/**
 * Allocate the pool entry an upload's bytes go into: a pending entry under the
 * owner's own partition, in a transaction of its own that takes the owner's
 * write fence first (a retired owner is refused, as every request write is).
 * Nothing names the entry until {@link publishOwnerMaterialUpload} roots it; an
 * entry never published expires like any pending allocation.
 *
 * @throws AssetQuotaExceededError when the owner's pool quota has no room.
 */
export async function allocateOwnerMaterialBytes(
  persistence: Pick<OwnerMaterialPersistence, 'withTransaction' | 'assetStoreIn'>,
  ownerId: string,
  bytes: Buffer,
  mime: string,
): Promise<string> {
  // A view over the received bytes rather than a copy of them.
  const part = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  const blob: BinaryBlob = new Blob([part], { type: mime });
  return persistence.withTransaction(async (tx) => {
    await fenceOwnerWrite(tx, ownerId);
    return persistence
      .assetStoreIn(tx)
      .put(assetPrincipalForOwner(ownerId), blob, { contentType: mime });
  });
}

/**
 * Publish an upload: its pool pointer, its `('material', id)` root, `'ready'`
 * and its extraction queued (`pending`, for the owner extraction scanner), in
 * one transaction (see `./material-roots.ts` for the fence and lock order).
 * Refused, writing nothing, unless the row is still this owner's live
 * reservation with room for the bytes and no pointer yet -- a publication
 * never replaces a pointer. Reserved bytes may only shrink.
 *
 * Throws what the request fence throws for a retired or busy owner.
 */
export async function publishOwnerMaterialUpload(
  persistence: Pick<OwnerMaterialPersistence, 'withTransaction'>,
  ownerId: string,
  materialId: string,
  input: { assetId: string; bytes: number; sha256: string },
): Promise<OwnerMaterialRecord | 'refused'> {
  return withMaterialRoots(
    persistence,
    { ownerId, fence: 'request', materialIds: [materialId] },
    async ({ tx, ownerId: owner, changeRoots }) => {
      const current = await tx.query<{
        owner_id: string;
        status: string;
        deleted_at: number | string | null;
        bytes: number | string;
        asset_id: string | null;
      }>(
        `SELECT owner_id, status, deleted_at, bytes, asset_id
           FROM owner_material
          WHERE id = $1`,
        [materialId],
      );
      const row = current.rows[0];
      if (
        !row ||
        row.owner_id !== owner ||
        row.status !== 'uploading' ||
        row.deleted_at !== null ||
        Number(row.bytes) < input.bytes ||
        row.asset_id !== null
      ) {
        return 'refused' as const;
      }
      await changeRoots({ add: [{ materialId, assetIds: [input.assetId] }] });
      const published = await tx.query<RawOwnerMaterialRow>(
        `UPDATE owner_material
            SET bytes = $2, sha256 = $3, status = 'ready', asset_id = $4,
                extraction = $5::jsonb
          WHERE id = $1
          RETURNING ${OWNER_MATERIAL_COLUMNS}`,
        [materialId, input.bytes, input.sha256, input.assetId, statusJson('pending')],
      );
      return ownerMaterialRowToRecord(published.rows[0]!);
    },
  );
}

/**
 * Delete one reservation that is still `uploading`, withdrawing any material
 * root it holds in the same transaction. A published upload never matches, so
 * this is safe to call when it is not known whether a publication committed.
 *
 * The fence follows a claim (`'background'`): a claim moves reservations with
 * the rest of the owner's materials, and removing the moved row for the
 * account is what the cleanup is for. Uploads write no root before they are
 * published, so the withdrawal normally finds none; it is there so that a
 * deleted row can never leave a root holding its bytes and quota.
 */
async function deleteUploadingRow(
  persistence: Pick<OwnerMaterialPersistence, 'withTransaction'>,
  ownerId: string,
  materialId: string,
): Promise<void> {
  await withMaterialRoots(
    persistence,
    { ownerId, fence: 'background', materialIds: [materialId] },
    async ({ tx, changeRoots }) => {
      const current = await tx.query<{ status: string }>(
        'SELECT status FROM owner_material WHERE id = $1',
        [materialId],
      );
      if (current.rows[0]?.status !== 'uploading') return;
      const roots = await tx.query<{ asset_id: string }>(
        `SELECT asset_id FROM asset_root_refs
          WHERE root_kind = $1 AND root_id = $2
          ORDER BY asset_id`,
        [MATERIAL_ROOT_KIND, materialId],
      );
      if (roots.rows.length > 0) {
        await changeRoots({
          remove: [{ materialId, assetIds: roots.rows.map((root) => root.asset_id) }],
        });
      }
      await tx.query(`DELETE FROM owner_material WHERE id = $1 AND status = 'uploading'`, [
        materialId,
      ]);
    },
  );
}

/** Remove a failed reservation; crash leftovers are handled by the 24h lazy sweep. */
export async function abandonOwnerMaterial(
  persistence: Pick<OwnerMaterialPersistence, 'withTransaction'>,
  ownerId: string,
  materialId: string,
): Promise<void> {
  await deleteUploadingRow(persistence, ownerId, materialId);
}

/** List the owner's ready library materials, newest first. */
export async function listOwnerMaterials(
  queryable: Queryable,
  ownerId: string,
): Promise<OwnerMaterialRecord[]> {
  const result = await queryable.query<RawOwnerMaterialRow>(
    `SELECT ${OWNER_MATERIAL_COLUMNS}
       FROM owner_material
      WHERE owner_id = $1 AND status = 'ready' AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    [ownerId],
  );
  return result.rows.map(ownerMaterialRowToRecord);
}

/** Resolve selected ready materials without exposing another owner's rows. */
export async function getReadyOwnerMaterials(
  queryable: Queryable,
  ownerId: string,
  materialIds: readonly string[],
): Promise<OwnerMaterialRecord[]> {
  if (materialIds.length === 0) return [];
  const result = await queryable.query<RawOwnerMaterialRow>(
    `SELECT ${OWNER_MATERIAL_COLUMNS}
       FROM owner_material
      WHERE owner_id = $1
        AND id = ANY($2::text[])
        AND status = 'ready'
        AND deleted_at IS NULL`,
    [ownerId, [...materialIds]],
  );
  return result.rows.map(ownerMaterialRowToRecord);
}

/** What {@link reassignMaterialFolders} did with one of the source owner's folders. */
export interface MaterialFolderReassignment {
  /** The source owner's folder id. */
  fromFolderId: string;
  /** The target owner's folder its materials are filed in now. */
  toFolderId: string;
  /**
   * `moved`: the folder moved as it was. `merged`: the target already had a
   * folder of the same normalized name, so the materials joined it and the
   * source folder is gone. `renumbered`: the target already used the folder's
   * id for a differently named folder, so the folder moved under a fresh id.
   */
  outcome: 'moved' | 'merged' | 'renumbered';
}

interface MaterialFolderRow extends Record<string, unknown> {
  owner_id: string;
  id: string;
  name: string;
  normalized_name: string;
  created_at: number | string;
  updated_at: number | string;
}

/**
 * Move every material and material folder of one owner to another: the
 * material half of a claim (`./owner-claims.ts`). `tx` must be the claim's
 * open transaction, after the owners' identity and quota locks.
 *
 * Folder collisions resolve the way course folders do
 * (`reassignDocumentFolders` in the storage package): a source folder whose
 * normalized name the target already uses is merged into the target's folder;
 * otherwise one whose id the target already uses moves under a fresh id;
 * otherwise it moves unchanged. Every material moves, filed or not --
 * `folder_id IS NULL` is Unfiled and stays Unfiled -- and a filed one follows
 * its folder's mapping.
 *
 * The statement order is what the `ON DELETE RESTRICT` folder foreign key
 * requires: the target folders exist before any material points at them, and
 * the source folders are deleted only after no material does. Reference roots
 * are keyed by material id, which does not change, so none is touched here.
 */
export async function reassignMaterialFolders(
  tx: Queryable,
  fromOwnerId: string,
  toOwnerId: string,
  createFolderId: () => string = () => globalThis.crypto.randomUUID(),
): Promise<{ materials: number; folders: MaterialFolderReassignment[] }> {
  // As `reassignDocumentFolders`: moving an owner onto itself moves nothing.
  // Without this, the final DELETE would drop the owner's own folders.
  if (fromOwnerId === toOwnerId) return { materials: 0, folders: [] };
  // Both owners' folder rows, then the source's material rows, each in one
  // ordered statement before anything is written.
  const folderRows = await tx.query<MaterialFolderRow>(
    `SELECT owner_id, id, name, normalized_name, created_at, updated_at
       FROM material_folders
      WHERE owner_id IN ($1, $2)
      ORDER BY owner_id, id
        FOR UPDATE`,
    [fromOwnerId, toOwnerId],
  );
  await tx.query('SELECT id FROM owner_material WHERE owner_id = $1 ORDER BY id FOR UPDATE', [
    fromOwnerId,
  ]);

  const target = folderRows.rows.filter((row) => row.owner_id === toOwnerId);
  const source = folderRows.rows
    .filter((row) => row.owner_id === fromOwnerId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const targetByName = new Map(target.map((row) => [row.normalized_name, row.id]));
  const usedIds = new Set(target.map((row) => row.id));
  const plan: MaterialFolderReassignment[] = [];
  const inserts: MaterialFolderRow[] = [];
  for (const folder of source) {
    const merged = targetByName.get(folder.normalized_name);
    if (merged !== undefined) {
      plan.push({ fromFolderId: folder.id, toFolderId: merged, outcome: 'merged' });
      continue;
    }
    let id = folder.id;
    let outcome: MaterialFolderReassignment['outcome'] = 'moved';
    if (usedIds.has(id)) {
      do id = createFolderId();
      while (usedIds.has(id));
      outcome = 'renumbered';
    }
    usedIds.add(id);
    targetByName.set(folder.normalized_name, id);
    inserts.push({ ...folder, id });
    plan.push({ fromFolderId: folder.id, toFolderId: id, outcome });
  }

  // Every filed material must have a mapping. The foreign key already makes
  // this so; checking it here turns a violation into a loud rollback instead
  // of a material silently landing Unfiled below.
  const mapped = new Set(plan.map((entry) => entry.fromFolderId));
  const filed = await tx.query<{ folder_id: string } & Record<string, unknown>>(
    `SELECT DISTINCT folder_id FROM owner_material
      WHERE owner_id = $1 AND folder_id IS NOT NULL`,
    [fromOwnerId],
  );
  if (filed.rows.some((row) => !mapped.has(row.folder_id))) {
    throw new Error('owner materials: a filed material names a folder its owner does not have');
  }

  for (const folder of inserts) {
    await tx.query(
      `INSERT INTO material_folders
         (owner_id, id, name, normalized_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        toOwnerId,
        folder.id,
        folder.name,
        folder.normalized_name,
        Number(folder.created_at),
        Number(folder.updated_at),
      ],
    );
  }
  // One statement over every source material, Unfiled included: an inner
  // join against the mapping would skip folder_id IS NULL and leave those
  // rows under the retired owner.
  const moved = await tx.query<{ id: string } & Record<string, unknown>>(
    `UPDATE owner_material AS material
        SET owner_id = $2,
            folder_id = CASE
              WHEN material.folder_id IS NULL THEN NULL
              ELSE (SELECT moves.to_id
                      FROM unnest($3::text[], $4::text[]) AS moves(from_id, to_id)
                     WHERE moves.from_id = material.folder_id)
            END
      WHERE material.owner_id = $1
      RETURNING material.id`,
    [
      fromOwnerId,
      toOwnerId,
      plan.map((entry) => entry.fromFolderId),
      plan.map((entry) => entry.toFolderId),
    ],
  );
  await tx.query('DELETE FROM material_folders WHERE owner_id = $1', [fromOwnerId]);
  return { materials: moved.rows.length, folders: plan };
}
