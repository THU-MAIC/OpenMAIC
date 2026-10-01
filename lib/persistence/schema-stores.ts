/**
 * Every schema store this application provisions, in its bootstrap order: the
 * storage package's PostgreSQL backends and this application's own tables.
 *
 * Several are provisioned lazily, by the feature that uses them (the agent
 * runtime's sessions, session materials and user skills), so no single
 * bootstrap call covers them all. This list is what the startup check verifies
 * against the database (./schema-boot-check.ts), and what the upgrade and
 * checksum tests enumerate; a new store belongs here.
 */
import { AGENT_SESSION_PG_MIGRATIONS } from '@openmaic/storage/agent-session/pg';
import { ASSET_PG_MIGRATIONS } from '@openmaic/storage/asset/pg';
import { DOCUMENT_PG_MIGRATIONS } from '@openmaic/storage/document/pg';
import { AGENT_SESSION_MATERIAL_PG_MIGRATIONS } from '@openmaic/storage/material/pg';
import type { SchemaMigrationSet } from '@openmaic/storage/pg-migrations';
import { RUNTIME_PG_MIGRATIONS } from '@openmaic/storage/runtime/pg';
import { USER_SKILL_PG_MIGRATIONS } from '@openmaic/storage/skill/pg';

import { CLASSROOM_GENERATION_JOB_MIGRATIONS } from './classroom-generation-jobs';
import { LEGACY_CLASSROOM_IMPORT_MIGRATIONS } from './legacy-classroom-imports';
import { LEGACY_IMPORT_BINDING_MIGRATIONS } from './legacy-import-bindings';
import { OWNER_MATERIAL_MIGRATIONS } from './owner-materials';
import { OWNER_MERGE_MIGRATIONS } from './owner-merges';
import { STAGE_META_MIGRATIONS } from './stage-meta';
import { WORKSPACE_MODEL_CONFIG_MIGRATIONS } from './workspace-model-config';

export const APP_SCHEMA_STORES: readonly SchemaMigrationSet[] = [
  RUNTIME_PG_MIGRATIONS,
  DOCUMENT_PG_MIGRATIONS,
  STAGE_META_MIGRATIONS,
  OWNER_MERGE_MIGRATIONS,
  LEGACY_IMPORT_BINDING_MIGRATIONS,
  OWNER_MATERIAL_MIGRATIONS,
  ASSET_PG_MIGRATIONS,
  CLASSROOM_GENERATION_JOB_MIGRATIONS,
  LEGACY_CLASSROOM_IMPORT_MIGRATIONS,
  WORKSPACE_MODEL_CONFIG_MIGRATIONS,
  AGENT_SESSION_PG_MIGRATIONS,
  AGENT_SESSION_MATERIAL_PG_MIGRATIONS,
  USER_SKILL_PG_MIGRATIONS,
];
