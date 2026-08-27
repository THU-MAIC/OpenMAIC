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
 * Bytes live in the neutral material byte store. The row records its private
 * object key, matching the reference metadata shape without vendor storage.
 *
 * ## Upload lifecycle
 *
 * An upload reserves a row with `status = 'uploading'` (quota-checked against
 * the owner's active source materials), streams its bytes into the byte
 * byte store through a sha256 meter, then finalizes the row to `'ready'` with
 * the digest. A failed upload abandons the row; a process death leaves
 * `uploading` rows behind, which the next upload's 24-hour reclaim removes --
 * its object first, then the reservation, so a crash mid-reclaim never loses
 * the pointer to the bytes.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

export const OWNER_MATERIAL_STATUSES = ['uploading', 'ready'] as const;
export type OwnerMaterialStatus = (typeof OWNER_MATERIAL_STATUSES)[number];

export const OWNER_MATERIAL_KINDS = ['source', 'web'] as const;
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
  /** Private material-byte-store object key. */
  ossKey: string;
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
`;

export async function ensureOwnerMaterialSchema(queryable: Queryable): Promise<void> {
  for (const sql of OWNER_MATERIAL_SCHEMA.split(';')) {
    const statement = sql.trim();
    if (statement !== '') await queryable.query(statement);
  }
}

interface RawOwnerMaterialRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  kind: string;
  derived_from: string | null;
  mime: string | null;
  bytes: number | string;
  original_name: string | null;
  oss_key: string;
  sha256: string | null;
  status: string;
  extraction: unknown;
  created_at: number | string;
  deleted_at: number | string | null;
}

const OWNER_MATERIAL_COLUMNS = `id,
  owner_id,
  kind,
  derived_from,
  mime,
  bytes,
  original_name,
  oss_key,
  sha256,
  status,
  extraction,
  created_at,
  deleted_at`;

function rowToRecord(row: RawOwnerMaterialRow): OwnerMaterialRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind as OwnerMaterialKind,
    derivedFrom: row.derived_from,
    mime: row.mime,
    bytes: Number(row.bytes),
    originalName: row.original_name,
    ossKey: row.oss_key,
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
 * Reclaim uploads that crashed before finalize and are older than the sweep
 * horizon.
 *
 * Order is load-bearing: each stale reservation's byte object is removed
 * first, and only then is the reservation deleted. Deleting the reservation
 * first would lose the pointer to its bytes on a crash between the two, so the
 * object would remain orphaned forever. A reservation whose byte deletion
 * throws is left in place (still quota-counted)
 * and the next pass retries it.
 *
 * @param deleteBytes Reclaims one recorded object key; must resolve when the
 *   object is removed or confirmed already absent, and throw to keep the
 *   reservation for the next pass.
 */
export async function reclaimStaleOwnerMaterialUploads(
  queryable: Queryable,
  ownerId: string,
  deleteBytes: (ossKey: string) => Promise<void>,
): Promise<void> {
  const staleBefore = Date.now() - STALE_UPLOAD_AGE_MS;
  const stale = await queryable.query<{ id: string; oss_key: string }>(
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
    await queryable.query(
      `DELETE FROM owner_material
        WHERE id = $1 AND status = 'uploading'`,
      [row.id],
    );
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
        input.extraction ? JSON.stringify(input.extraction) : null,
        Date.now(),
      ],
    );
    return rowToRecord(inserted.rows[0]);
  });
}

/** Finalize a successfully stored object. Reserved bytes may only shrink. */
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
  return rowToRecord(result.rows[0]);
}

/** Remove a failed reservation; crash leftovers are handled by the 24h lazy sweep. */
export async function abandonOwnerMaterial(
  queryable: Queryable,
  materialId: string,
): Promise<void> {
  await queryable.query(`DELETE FROM owner_material WHERE id = $1 AND status = 'uploading'`, [
    materialId,
  ]);
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
  return result.rows.map(rowToRecord);
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
  return result.rows.map(rowToRecord);
}
