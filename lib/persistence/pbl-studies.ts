import { applySchemaMigrations } from '@openmaic/storage/pg-migrations';
import type { Queryable } from '@openmaic/storage/document/pg';

export const PBL_MIGRATIONS = {
  store: 'pbl-v3',
  migrations: [
    {
      version: 1,
      name: 'learning-runtime',
      transaction: true,
      up: `
CREATE TABLE pbl_v3_studies (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, stage_id TEXT NOT NULL, scene_id TEXT NOT NULL,
 project_id TEXT NOT NULL, project_version TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 state JSONB NOT NULL, environment_id TEXT, evaluation JSONB,
 UNIQUE(owner_id, stage_id, scene_id)
);
CREATE TABLE pbl_v3_roles (
 session_id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES pbl_v3_studies(id),
 role TEXT NOT NULL CHECK(role IN ('mentor','discussion','planner','coder')),
 context_key TEXT NOT NULL, stage_key TEXT NOT NULL, feedback_seq INTEGER NOT NULL DEFAULT 0, guided JSONB, completion JSONB,
 UNIQUE(study_id, role, context_key)
);
CREATE TABLE pbl_v3_commands (
 study_id TEXT NOT NULL REFERENCES pbl_v3_studies(id), id TEXT NOT NULL,
 hash TEXT NOT NULL, result JSONB, stage_key TEXT NOT NULL, PRIMARY KEY(study_id,id)
);
CREATE TABLE pbl_v3_events (
 study_id TEXT NOT NULL REFERENCES pbl_v3_studies(id), sequence INTEGER NOT NULL,
 event JSONB NOT NULL, PRIMARY KEY(study_id,sequence)
);`,
    },
    {
      version: 2,
      name: 'learning-environment-recovery',
      transaction: true,
      up: `ALTER TABLE pbl_v3_studies
        ADD COLUMN environment_checked_at TIMESTAMPTZ,
        ADD COLUMN environment_recovery JSONB;`,
    },
    {
      version: 3,
      name: 'pin-project-template',
      transaction: true,
      up: 'ALTER TABLE pbl_v3_studies ADD COLUMN project_reference JSONB;',
    },
    {
      version: 4,
      name: 'retain-study-project-assets',
      transaction: true,
      up: `
SELECT d.id FROM document_stages d
 WHERE EXISTS (SELECT 1 FROM pbl_v3_studies s JOIN stage_meta m ON m.stage_id=s.stage_id
   WHERE s.stage_id=d.id AND m.owner_id=s.owner_id AND m.deleted_at IS NULL
     AND s.project_reference->>'assetId' IS NOT NULL)
 ORDER BY d.id FOR UPDATE;
SELECT e.id FROM asset_entries e
 WHERE EXISTS (SELECT 1 FROM pbl_v3_studies s JOIN stage_meta m ON m.stage_id=s.stage_id
   WHERE e.id=s.project_reference->>'assetId' AND e.principal='owner:' || s.owner_id
     AND m.owner_id=s.owner_id AND m.deleted_at IS NULL)
 ORDER BY e.id FOR UPDATE;
INSERT INTO document_asset_refs(stage_id,scope,scene_id,asset_id)
 SELECT s.stage_id,'retained',s.id,e.id FROM pbl_v3_studies s
 JOIN document_stages d ON d.id=s.stage_id
 JOIN stage_meta m ON m.stage_id=s.stage_id AND m.owner_id=s.owner_id AND m.deleted_at IS NULL
 JOIN pbl_project_installations p ON p.asset_id=s.project_reference->>'assetId'
 JOIN asset_entries e ON e.id=p.asset_id AND e.principal='owner:' || s.owner_id
 WHERE p.checksum=s.project_reference->>'checksum' AND e.content_hash=p.content_hash AND e.revision=1
   AND p.project_id=s.project_id AND p.project_version=s.project_version
   AND p.project_id=s.project_reference->>'id' AND p.project_version=s.project_reference->>'version'
 ON CONFLICT DO NOTHING;
UPDATE asset_entries e SET committed_at=COALESCE(e.committed_at,now()),expires_at=NULL,unreferenced_at=NULL
 WHERE EXISTS (SELECT 1 FROM document_asset_refs r WHERE r.asset_id=e.id AND r.scope='retained');`,
    },
  ],
};

/** Bootstrap before enabling collection so upgrade backfills preserve existing study pins. */
export const ensurePBLStudySchema = (db: Queryable) => applySchemaMigrations(db, PBL_MIGRATIONS);
