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
 * Bytes live in the host's hash-addressed asset registry (the spec's neutral
 * replacement for the reference's OSS byte path): the row records the returned
 * asset id instead of an object key.
 *
 * ## Upload lifecycle
 *
 * An upload reserves a row with `status = 'uploading'` (quota-checked against
 * the owner's active source materials), streams its bytes into the asset
 * registry through a sha256 meter, then finalizes the row to `'ready'` with the
 * digest. A failed upload abandons the row; a process death leaves `uploading`
 * rows behind, which the next upload's 24-hour lazy sweep deletes (and its
 * caller best-effort removes the orphaned bytes).
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
  /** Asset-registry id for the private bytes (the reference's `ossKey`). */
  assetId: string;
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
    readonly stale: Array<{ id: string; assetId: string }> = [],
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
  assetId: string;
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
  asset_id TEXT NOT NULL,
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
  asset_id: string;
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
  asset_id,
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
 * Reserve one uploading row under the owner's quota.
 *
 * Runs in a transaction: the 24-hour lazy sweep of stale `uploading` rows, the
 * quota check, and the INSERT are one unit, so concurrent uploads cannot
 * double-spend the owner's quota. Returns the swept stale rows so the caller
 * can best-effort delete their orphaned asset-registry bytes.
 */
export async function registerOwnerMaterial(
  queryable: ConnectableQueryable,
  input: RegisterOwnerMaterialInput,
  limits: OwnerMaterialRegistrationLimits,
): Promise<{ record: OwnerMaterialRecord; stale: Array<{ id: string; assetId: string }> }> {
  const staleBefore = Date.now() - STALE_UPLOAD_AGE_MS;
  const withTransaction = nodePostgresTransaction(queryable);
  return withTransaction(async (tx) => {
    const staleResult = await tx.query<RawOwnerMaterialRow>(
      `DELETE FROM owner_material
        WHERE owner_id = $1
          AND status = 'uploading'
          AND created_at < $2
       RETURNING ${OWNER_MATERIAL_COLUMNS}`,
      [input.ownerId, staleBefore],
    );
    const stale = staleResult.rows.map((row) => ({ id: row.id, assetId: row.asset_id }));

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
      throw new MaterialQuotaExceededError('count', limits.maxCount, stale);
    }
    if (totalBytes + input.bytes > limits.maxTotalBytes) {
      throw new MaterialQuotaExceededError('bytes', limits.maxTotalBytes, stale);
    }

    const inserted = await tx.query<RawOwnerMaterialRow>(
      `INSERT INTO owner_material
         (id, owner_id, kind, derived_from, mime, bytes, original_name,
          asset_id, sha256, status, extraction, created_at)
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
        input.assetId,
        input.extraction ? JSON.stringify(input.extraction) : null,
        Date.now(),
      ],
    );
    return { record: rowToRecord(inserted.rows[0]), stale };
  });
}

/** Finalize a successfully stored object. Reserved bytes may only shrink. */
export async function finalizeOwnerMaterial(
  queryable: Queryable,
  materialId: string,
  bytes: number,
  sha256: string,
  assetId: string,
): Promise<OwnerMaterialRecord> {
  const result = await queryable.query<RawOwnerMaterialRow>(
    `UPDATE owner_material
        SET bytes = $2, sha256 = $3, status = 'ready', asset_id = $4
      WHERE id = $1
        AND status = 'uploading'
        AND deleted_at IS NULL
        AND bytes >= $2
      RETURNING ${OWNER_MATERIAL_COLUMNS}`,
    [materialId, bytes, sha256, assetId],
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
