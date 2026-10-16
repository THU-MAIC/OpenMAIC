/**
 * PBL v2 — repo registry (owner-scoped).
 *
 * The server-side record that maps a learner's PBL project to the Gitea fork
 * provisioned for it (`lib/pbl/v2/git-bridge/provision.ts`). Two lookup shapes
 * live on the one table:
 *
 *   - `(owner_id, stage_id)` — the enrollment key, so re-enrolling the same
 *     project is idempotent and never re-forks;
 *   - `repo_full_name` — the webhook key, so a push event's `repository.full_name`
 *     resolves back to the project (and its `domain_id`) without the learner's
 *     session.
 *
 * Follows the `stage-meta.ts` / `owner-materials.ts` pattern: a versioned
 * schema migration ensured at bootstrap, and owner writes fenced by the
 * per-owner identity lock (`fenceOwnerWrite`) so an enrollment racing a claim
 * is refused rather than left under a retired id.
 */

import type { Queryable } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import { ensureOwnerMergeSchema, fenceOwnerWrite } from './owner-merges';

export interface PBLRepoRegistryRow {
  ownerId: string;
  stageId: string;
  sceneId: string | null;
  domainId: string | null;
  giteaUsername: string;
  repoFullName: string;
  cloneUrl: string;
  htmlUrl: string | null;
  /** The learner's repo-scoped token (sensitive; server-side only). */
  token: string;
  tokenLastEight: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertPBLRepoInput {
  ownerId: string;
  stageId: string;
  sceneId?: string;
  domainId?: string;
  giteaUsername: string;
  repoFullName: string;
  cloneUrl: string;
  htmlUrl?: string | null;
  token: string;
  tokenLastEight?: string;
}

export const PBL_REPO_REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS pbl_repo_registry (
  owner_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  scene_id TEXT,
  domain_id TEXT,
  gitea_username TEXT NOT NULL,
  repo_full_name TEXT NOT NULL UNIQUE,
  clone_url TEXT NOT NULL,
  html_url TEXT,
  token TEXT NOT NULL,
  token_last_eight TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, stage_id)
);
`;

export const PBL_REPO_REGISTRY_MIGRATIONS: SchemaMigrationSet = {
  store: 'pbl-repo-registry',
  migrations: [{ version: 1, name: 'baseline', up: PBL_REPO_REGISTRY_SCHEMA, transaction: false }],
};

export async function ensurePBLRepoRegistrySchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, PBL_REPO_REGISTRY_MIGRATIONS);
  // The write fence reads the claim records (./owner-merges.ts).
  await ensureOwnerMergeSchema(queryable);
}

interface RawPBLRepoRegistryRow extends Record<string, unknown> {
  owner_id: string;
  stage_id: string;
  scene_id: string | null;
  domain_id: string | null;
  gitea_username: string;
  repo_full_name: string;
  clone_url: string;
  html_url: string | null;
  token: string;
  token_last_eight: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const PBL_REPO_REGISTRY_COLUMNS = `owner_id,
  stage_id,
  scene_id,
  domain_id,
  gitea_username,
  repo_full_name,
  clone_url,
  html_url,
  token,
  token_last_eight,
  created_at,
  updated_at`;

function rowToRecord(row: RawPBLRepoRegistryRow): PBLRepoRegistryRow {
  return {
    ownerId: row.owner_id,
    stageId: row.stage_id,
    sceneId: row.scene_id,
    domainId: row.domain_id,
    giteaUsername: row.gitea_username,
    repoFullName: row.repo_full_name,
    cloneUrl: row.clone_url,
    htmlUrl: row.html_url,
    token: row.token,
    tokenLastEight: row.token_last_eight,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}

/** The flat view the enroll/repo routes return to the client. */
export interface PBLRepoPublicView {
  fullName: string;
  cloneUrl: string;
  htmlUrl: string | null;
  username: string;
  token: string;
  tokenLastEight: string | null;
  stageId: string;
  domainId: string | null;
}

export function publicRepoView(row: PBLRepoRegistryRow): PBLRepoPublicView {
  return {
    fullName: row.repoFullName,
    cloneUrl: row.cloneUrl,
    htmlUrl: row.htmlUrl,
    username: row.giteaUsername,
    token: row.token,
    tokenLastEight: row.tokenLastEight,
    stageId: row.stageId,
    domainId: row.domainId,
  };
}

/** Resolve the fork for a learner's project, or `null` when not enrolled. */
export async function findRepoByOwnerStage(
  queryable: Queryable,
  ownerId: string,
  stageId: string,
): Promise<PBLRepoRegistryRow | null> {
  const result = await queryable.query<RawPBLRepoRegistryRow>(
    `SELECT ${PBL_REPO_REGISTRY_COLUMNS}
       FROM pbl_repo_registry
      WHERE owner_id = $1 AND stage_id = $2`,
    [ownerId, stageId],
  );
  const row = result.rows[0];
  return row ? rowToRecord(row) : null;
}

/** Resolve the project a push event's repo full name belongs to, or `null`. */
export async function findRepoByFullName(
  queryable: Queryable,
  fullName: string,
): Promise<PBLRepoRegistryRow | null> {
  const result = await queryable.query<RawPBLRepoRegistryRow>(
    `SELECT ${PBL_REPO_REGISTRY_COLUMNS}
       FROM pbl_repo_registry
      WHERE repo_full_name = $1`,
    [fullName],
  );
  const row = result.rows[0];
  return row ? rowToRecord(row) : null;
}

/**
 * Record a provisioned fork. Idempotent: on a concurrent enrollment the insert
 * conflicts and the already-committed row is returned. Fenced by the per-owner
 * identity lock so a racing claim is refused rather than left under a retired
 * id (see ./owner-merges.ts).
 */
export async function upsertPBLRepo(
  queryable: ConnectableQueryable,
  input: UpsertPBLRepoInput,
): Promise<PBLRepoRegistryRow> {
  const withTransaction = nodePostgresTransaction(queryable);
  return withTransaction(async (tx) => {
    await fenceOwnerWrite(tx, input.ownerId);

    await tx.query(
      `INSERT INTO pbl_repo_registry
         (owner_id, stage_id, scene_id, domain_id, gitea_username,
          repo_full_name, clone_url, html_url, token, token_last_eight)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (owner_id, stage_id) DO NOTHING`,
      [
        input.ownerId,
        input.stageId,
        input.sceneId ?? null,
        input.domainId ?? null,
        input.giteaUsername,
        input.repoFullName,
        input.cloneUrl,
        input.htmlUrl ?? null,
        input.token,
        input.tokenLastEight ?? null,
      ],
    );

    const existing = await findRepoByOwnerStage(tx, input.ownerId, input.stageId);
    if (!existing) throw new Error('pbl repo registry insert did not produce a row');
    return existing;
  });
}
