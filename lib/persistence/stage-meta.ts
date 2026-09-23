import { DocumentNotFoundError } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';

export interface StageMetaRow {
  stageId: string;
  ownerId: string;
  isPublic: boolean;
  /** Epoch millis when the owner published the course; null while private. */
  publishedAt: number | null;
  /** Server-side mirror of the document outline's generation-complete flag. */
  generationComplete: boolean;
  deletedAt: Date | null;
}

interface RawStageMetaRow extends Record<string, unknown> {
  stage_id: string;
  owner_id: string;
  is_public: boolean;
  published_at: number | string | null;
  generation_complete: boolean;
  deleted_at: Date | string | null;
}

export const STAGE_META_SCHEMA = `
CREATE TABLE IF NOT EXISTS stage_meta (
  stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  is_public BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ
);

ALTER TABLE stage_meta
  ADD COLUMN IF NOT EXISTS published_at DOUBLE PRECISION;

ALTER TABLE stage_meta
  ADD COLUMN IF NOT EXISTS generation_complete BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS stage_meta_owner_idx ON stage_meta (owner_id, stage_id);

CREATE INDEX IF NOT EXISTS stage_meta_public_live_idx
  ON stage_meta (stage_id) WHERE is_public AND deleted_at IS NULL;
`;

/** Whether `document_stages` still has the retired `owner_id` column. */
async function hasLegacyDocumentOwnerColumn(queryable: Queryable): Promise<boolean> {
  const result = await queryable.query<{ present: boolean } & Record<string, unknown>>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_attribute
        WHERE attrelid = to_regclass('document_stages')
          AND attname = 'owner_id'
          AND NOT attisdropped
     ) AS present`,
  );
  return result.rows[0]?.present === true;
}

/** What {@link adoptLegacyDocumentOwners} found; all zero on a database without the column. */
export interface LegacyOwnerAdoption {
  /** Courses whose only ownership record was the document row, now in `stage_meta`. */
  adopted: number;
  /** Courses whose document row names a different owner than `stage_meta`, which wins. */
  disagreeing: number;
}

/**
 * Copy ownership recorded only on `document_stages.owner_id` into
 * `stage_meta`.
 *
 * Nothing reads that column any more -- `stage_meta` is the only ownership
 * record -- so a course written before `stage_meta` existed, whose owner is
 * on its document row alone, would otherwise belong to no one. Idempotent: an
 * existing ownership row is never touched (`ON CONFLICT DO NOTHING`), so a
 * second boot adopts nothing, and where the two records disagree `stage_meta`
 * stands and the disagreement is counted for an operator. A database created
 * without the column has nothing to adopt.
 */
export async function adoptLegacyDocumentOwners(
  queryable: Queryable,
): Promise<LegacyOwnerAdoption> {
  if (!(await hasLegacyDocumentOwnerColumn(queryable))) return { adopted: 0, disagreeing: 0 };
  const adopted = await queryable.query<{ stage_id: string } & Record<string, unknown>>(
    `INSERT INTO stage_meta (stage_id, owner_id)
     SELECT id, owner_id
       FROM document_stages
      WHERE owner_id IS NOT NULL
     ON CONFLICT (stage_id) DO NOTHING
     RETURNING stage_id`,
  );
  const disagreeing = await queryable.query<{ count: string } & Record<string, unknown>>(
    `SELECT COUNT(*)::text AS count
       FROM document_stages AS stages
       JOIN stage_meta AS meta ON meta.stage_id = stages.id
      WHERE stages.owner_id IS NOT NULL
        AND stages.owner_id <> meta.owner_id`,
  );
  return {
    adopted: adopted.rows.length,
    disagreeing: Number(disagreeing.rows[0]?.count ?? 0),
  };
}

/**
 * Ensure the schema, and adopt owned documents that have no ownership row.
 *
 * The adoption ({@link adoptLegacyDocumentOwners}) is a backfill for databases
 * written before `stage_meta` existed, and must run before anything serves a
 * course: nothing else reads the owner recorded on a document row. It runs at
 * provider startup, outside any request, so it records ownership **without**
 * the host create hooks (`authorizeCreate` / `onCreate`): there is no request,
 * principal, or create transaction to run them in. On a database this version
 * created, every course is claimed with its hooks at creation and the
 * backfill adopts nothing; when it does adopt, it says how many so an operator
 * can reconcile any host rows those courses lack.
 */
export async function ensureStageMetaSchema(queryable: Queryable): Promise<void> {
  for (const sql of STAGE_META_SCHEMA.split(';')) {
    const statement = sql.trim();
    if (statement === '') continue;
    await queryable.query(statement);
  }
  const { adopted, disagreeing } = await adoptLegacyDocumentOwners(queryable);
  if (adopted > 0) {
    console.warn(
      `[stage-meta] adopted ${adopted} owned course(s) without an ownership row; ` +
        'host create hooks do not run for adopted courses.',
    );
  }
  if (disagreeing > 0) {
    console.warn(
      `[stage-meta] ${disagreeing} course(s) name a different owner on the retired ` +
        'document_stages.owner_id column than in stage_meta; stage_meta is authoritative.',
    );
  }
}

export async function readStageMeta(
  queryable: Queryable,
  stageId: string,
): Promise<StageMetaRow | null> {
  const result = await queryable.query<RawStageMetaRow>(
    `SELECT stage_id, owner_id, is_public, published_at, generation_complete, deleted_at
       FROM stage_meta
      WHERE stage_id = $1`,
    [stageId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const publishedAt = row.published_at;
  return {
    stageId: row.stage_id,
    ownerId: row.owner_id,
    isPublic: row.is_public === true,
    publishedAt:
      publishedAt === null
        ? null
        : typeof publishedAt === 'number'
          ? publishedAt
          : Number(publishedAt),
    generationComplete: row.generation_complete === true,
    deletedAt:
      row.deleted_at === null
        ? null
        : row.deleted_at instanceof Date
          ? row.deleted_at
          : new Date(row.deleted_at),
  };
}

export type StageAccessRefusal = 'foreign' | 'unclaimed' | 'tombstoned' | 'reserved-document';

export class StageAccessError extends DocumentNotFoundError {
  constructor(
    stageId: string,
    readonly attemptedBy: string,
    readonly refusal: StageAccessRefusal,
  ) {
    super(stageId, `stage access refused (${refusal}) for ${JSON.stringify(stageId)}`);
    (this as { name: string }).name = 'StageAccessError';
  }
}

/**
 * Record that `ownerId` owns `stageId`. Resolves `true` when this call inserted
 * the ownership row -- the course was created by the calling transaction --
 * and `false` when the owner already held it (a concurrent create by the same
 * owner that committed first). A foreign owner is refused.
 */
export async function claimStageMeta(
  queryable: Queryable,
  stageId: string,
  ownerId: string,
): Promise<boolean> {
  const inserted = await queryable.query<{ owner_id: string } & Record<string, unknown>>(
    `INSERT INTO stage_meta (stage_id, owner_id)
     VALUES ($1, $2)
     ON CONFLICT (stage_id) DO NOTHING
     RETURNING owner_id`,
    [stageId, ownerId],
  );
  if (inserted.rows[0]?.owner_id === ownerId) return true;

  const existing = await queryable.query<{ owner_id: string } & Record<string, unknown>>(
    'SELECT owner_id FROM stage_meta WHERE stage_id = $1',
    [stageId],
  );
  if (existing.rows[0]?.owner_id !== ownerId) {
    throw new StageAccessError(stageId, ownerId, 'foreign');
  }
  return false;
}

export async function tombstoneStageMeta(queryable: Queryable, stageId: string): Promise<void> {
  await queryable.query(
    `UPDATE stage_meta
        SET deleted_at = CURRENT_TIMESTAMP
      WHERE stage_id = $1 AND deleted_at IS NULL`,
    [stageId],
  );
}

/** Monotonically mark a live course's server-side generation-complete flag. */
export async function markStageGenerationComplete(
  queryable: Queryable,
  stageId: string,
): Promise<boolean> {
  const result = await queryable.query<{ stage_id: string } & Record<string, unknown>>(
    `UPDATE stage_meta
        SET generation_complete = true
      WHERE stage_id = $1 AND deleted_at IS NULL
      RETURNING stage_id`,
    [stageId],
  );
  return result.rows.length === 1;
}

/** Publish (isPublic=true, publishedAt set) or unpublish (isPublic=false, publishedAt cleared). */
export async function setStagePublished(
  queryable: Queryable,
  stageId: string,
  isPublic: boolean,
  publishedAt: number | null,
): Promise<void> {
  await queryable.query(
    `UPDATE stage_meta
        SET is_public = $2, published_at = $3
      WHERE stage_id = $1 AND deleted_at IS NULL`,
    [stageId, isPublic, publishedAt],
  );
}
