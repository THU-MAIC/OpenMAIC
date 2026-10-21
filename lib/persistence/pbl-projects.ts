import { DocumentWriteRefusedError } from '@openmaic/storage';
import { applySchemaMigrations } from '@openmaic/storage/pg-migrations';
import type { Queryable } from '@openmaic/storage/document/pg';

/** An installation is a validated, pinned template asset. Asset collection removes this index too. */
export const PBL_PROJECT_MIGRATIONS = {
  store: 'pbl-projects',
  migrations: [
    {
      version: 1,
      name: 'validated-project-assets',
      transaction: true,
      up: `
CREATE TABLE pbl_project_installations (
 asset_id TEXT PRIMARY KEY REFERENCES asset_entries(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL, project_version TEXT NOT NULL,
 checksum TEXT NOT NULL, content_hash TEXT NOT NULL
);
CREATE INDEX pbl_project_installations_checksum_idx ON pbl_project_installations(checksum);`,
    },
  ],
};
export const ensurePBLProjectSchema = (db: Queryable) =>
  applySchemaMigrations(db, PBL_PROJECT_MIGRATIONS);

/** Runs on the document write transaction; a failure rolls back publication and its references. */
export async function assertDocumentProjectsInstalled(
  db: Queryable,
  stageId: string,
  ownerId: string,
) {
  const result = await db.query<{ ref: Record<string, unknown> }>(
    `SELECT data->'content'->'projectV3' AS ref FROM document_scenes
     WHERE stage_id=$1 AND data->'content'->'projectV3' IS NOT NULL`,
    [stageId],
  );
  for (const { ref } of result.rows) {
    if (!ref || typeof ref !== 'object') continue; // scene validation owns malformed references
    if (ref.packageId !== undefined)
      throw new DocumentWriteRefusedError(
        stageId,
        'PBL_PROJECT_UNAVAILABLE',
        'PBL package references must be installed before saving the classroom.',
      );
    if (ref.assetId === undefined) continue; // legacy deployment-owned built-ins
    const installed = await db.query(
      `SELECT 1 FROM pbl_project_installations p JOIN asset_entries e ON e.id=p.asset_id
       WHERE p.asset_id=$1 AND p.checksum=$2 AND p.project_id=$3 AND p.project_version=$4
         AND e.principal=$5 AND e.content_hash=p.content_hash AND e.revision=1
         AND EXISTS (SELECT 1 FROM document_asset_refs r WHERE r.stage_id=$6 AND r.asset_id=e.id)`,
      [ref.assetId, ref.checksum, ref.id, ref.version, `owner:${ownerId}`, stageId],
    );
    if (!installed.rows.length)
      throw new DocumentWriteRefusedError(
        stageId,
        'PBL_PROJECT_UNAVAILABLE',
        'PBL project resources are missing, changed or unavailable to this classroom owner.',
      );
  }
}
