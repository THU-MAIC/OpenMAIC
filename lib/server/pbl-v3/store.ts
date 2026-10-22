import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ensurePBLStudySchema } from '@/lib/persistence/pbl-studies';
import { retainDocumentAssets } from '@openmaic/storage/asset/pg';
import { PgAgentSessionStore } from '@openmaic/storage/agent-session/pg';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { notifyDurableAgentEvent } from '@/lib/server/agent-runtime/event-notify-bus';
import type { EngineTransition } from '@/lib/pbl/v3/domain/orchestration/events';
import type { PblSessionState } from '@/lib/pbl/v3/domain/orchestration/types';
import type { AgentRole } from '@/lib/pbl/v3/domain/project/project-schema';
import { SandboxError, sandboxConflict } from '@/lib/sandbox/errors';
import type { PBLV3Reference } from '@openmaic/dsl';
import type { InstalledProject } from './catalog';
import { resolveStudyProject } from './project-resolver';
import { fenceOwnerWrite } from '@/lib/persistence/owner-merges';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';

export interface Study extends Record<string, unknown> {
  id: string;
  owner_id: string;
  stage_id: string;
  scene_id: string;
  project_id: string;
  project_version: string;
  project_reference?: PBLV3Reference | null;
  /** Hydrated from durable template bytes on every read, never persisted with learner state. */
  project?: InstalledProject;
  revision: number;
  state: PblSessionState;
  environment_id: string | null;
  environment_checked_at: Date | null;
  environment_recovery: {
    requestId: string;
    checkpointRevision?: number;
    progressReset?: boolean;
    savedPosition?: {
      revision: number;
      milestoneIndex: number;
      stageIndex: number;
      fingerprint: string;
    };
  } | null;
  evaluation: {
    id: string;
    fingerprint: string;
    stageKey: string;
    startedAt: string;
    purpose?: 'compile';
  } | null;
}
export interface RoleBinding extends Record<string, unknown> {
  session_id: string;
  study_id: string;
  role: AgentRole;
  context_key: string;
  stage_key: string;
  feedback_seq: number;
  guided: import('./guided-review').GuidedSkillState | null;
  completion: { stageKey: string; feedbackSeq: number; userMessageSeq: number } | null;
}

const admitted = new WeakMap<Pool, number>();

export class LearningStore {
  constructor(readonly pool: Pool) {}
  static async open() {
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    await getAgentSessionStore();
    await withSchemaBootstrapLock(pool, ensurePBLStudySchema);
    return new LearningStore(pool);
  }
  async get(id: string, ownerId: string, db: Pool | PoolClient = this.pool): Promise<Study> {
    const result = await db.query<Study>(
      'SELECT * FROM pbl_v3_studies WHERE id=$1 AND owner_id=$2',
      [id, ownerId],
    );
    if (!result.rows[0])
      throw new SandboxError('PBL_NOT_FOUND', 404, 'Learning session is unavailable.');
    const row = result.rows[0];
    if (row.project_reference?.assetId)
      row.project = await resolveStudyProject(ownerId, row.stage_id, row.project_reference, row.id);
    return row;
  }
  async findForScene(ownerId: string, stageId: string, sceneId: string): Promise<Study | null> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT s.id FROM pbl_v3_studies s JOIN stage_meta m ON m.stage_id=s.stage_id
       WHERE s.owner_id=$1 AND s.stage_id=$2 AND s.scene_id=$3
         AND m.owner_id=$1 AND m.deleted_at IS NULL`,
      [ownerId, stageId, sceneId],
    );
    return result.rows[0] ? this.get(result.rows[0].id, ownerId) : null;
  }
  async binding(sessionId: string): Promise<RoleBinding | null> {
    return (
      (
        await this.pool.query<RoleBinding>('SELECT * FROM pbl_v3_roles WHERE session_id=$1', [
          sessionId,
        ])
      ).rows[0] ?? null
    );
  }
  async roles(id: string, db: Pool | PoolClient = this.pool) {
    return (await db.query<RoleBinding>('SELECT * FROM pbl_v3_roles WHERE study_id=$1', [id])).rows;
  }
  async create(
    input: {
      ownerId: string;
      stageId: string;
      sceneId: string;
      projectId: string;
      version: string;
      projectRef?: PBLV3Reference;
    },
    initial: EngineTransition,
  ) {
    return this.transaction(async (db) => {
      const ref = input.projectRef;
      if (ref?.assetId) {
        await fenceOwnerWrite(db, input.ownerId);
        const classroom = await db.query(
          `SELECT d.id FROM document_stages d JOIN stage_meta m ON m.stage_id=d.id
           WHERE d.id=$1 AND m.owner_id=$2 AND m.deleted_at IS NULL FOR UPDATE OF d`,
          [input.stageId, input.ownerId],
        );
        if (!classroom.rows.length)
          throw new SandboxError(
            'PBL_PROJECT_UNAVAILABLE',
            404,
            'The owning classroom is unavailable.',
          );
      }
      const inserted = await db.query<Study>(
        `INSERT INTO pbl_v3_studies(id,owner_id,stage_id,scene_id,project_id,project_version,state,project_reference)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner_id,stage_id,scene_id) DO NOTHING RETURNING *`,
        [
          randomUUID(),
          input.ownerId,
          input.stageId,
          input.sceneId,
          input.projectId,
          input.version,
          JSON.stringify(initial.state),
          JSON.stringify(input.projectRef ?? null),
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await db.query<Study>(
            'SELECT * FROM pbl_v3_studies WHERE owner_id=$1 AND stage_id=$2 AND scene_id=$3',
            [input.ownerId, input.stageId, input.sceneId],
          )
        ).rows[0]!;
      if (row.project_id !== input.projectId || row.project_version !== input.version)
        throw sandboxConflict('This learning instance is pinned to a different project version.');
      if ((row.project_reference?.checksum ?? null) !== (input.projectRef?.checksum ?? null))
        throw sandboxConflict('This learning instance is pinned to different project content.');
      if (ref?.assetId) {
        const pinned = row.project_reference!;
        const installed = await db.query(
          `SELECT 1 FROM pbl_project_installations p JOIN asset_entries e ON e.id=p.asset_id
           WHERE p.asset_id=$3 AND e.principal=$4 AND e.content_hash=p.content_hash AND e.revision=1
             AND p.checksum=$5 AND p.project_id=$6 AND p.project_version=$7
             AND (NOT $8::boolean OR EXISTS (SELECT 1 FROM document_scenes s
               WHERE s.stage_id=$1 AND s.id=$2
                 AND s.data->'content'->'projectV3'->>'assetId'=p.asset_id
                 AND s.data->'content'->'projectV3'->>'checksum'=p.checksum))
           FOR UPDATE OF e`,
          [
            input.stageId,
            input.sceneId,
            pinned.assetId,
            assetPrincipalForOwner(input.ownerId).key,
            pinned.checksum,
            pinned.id,
            pinned.version,
            inserted.rows.length > 0,
          ],
        );
        if (!installed.rows.length)
          throw new SandboxError(
            'PBL_PROJECT_UNAVAILABLE',
            404,
            'The pinned project is unavailable or the scene changed before admission.',
          );
        await retainDocumentAssets(db, {
          stageId: row.stage_id,
          referenceId: row.id,
          assetIds: [pinned.assetId!],
          principals: [assetPrincipalForOwner(input.ownerId).key],
        });
      }
      if (inserted.rows.length) await this.events(db, row.id, initial);
      return row;
    });
  }
  async transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const result = await fn(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
  /** Cross-process admission, including remote file I/O. Busy requests retry, never queue unboundedly. */
  async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const active = admitted.get(this.pool) ?? 0;
    if (active >= Math.max(1, Math.floor((this.pool.options.max ?? 10) / 4)))
      throw new SandboxError('PBL_BUSY', 429, 'Learning operations are busy. Retry shortly.');
    admitted.set(this.pool, active + 1);
    let db: PoolClient | undefined;
    let locked = false;
    let releaseError: Error | undefined;
    try {
      db = await this.pool.connect();
      locked = (
        await db.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
          [`pbl-v3:${id}`],
        )
      ).rows[0]!.locked;
      if (!locked)
        throw sandboxConflict('The learning session is busy. Retry after the current operation.');
      return await fn();
    } finally {
      try {
        if (locked)
          await db!.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`pbl-v3:${id}`]);
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error('Learning lock cleanup failed');
      } finally {
        db?.release(releaseError);
        admitted.set(this.pool, (admitted.get(this.pool) ?? 1) - 1);
      }
    }
  }

  async commit(db: PoolClient, row: Study, transition: EngineTransition) {
    const result = await db.query<Study>(
      `UPDATE pbl_v3_studies SET state=$3,revision=revision+1,environment_id=$4,evaluation=$5,environment_recovery=$6
      WHERE id=$1 AND revision=$2 RETURNING *`,
      [
        row.id,
        row.revision,
        JSON.stringify(transition.state),
        row.environment_id,
        JSON.stringify(row.evaluation),
        JSON.stringify(row.environment_recovery),
      ],
    );
    if (!result.rows[0])
      throw sandboxConflict('Learning progress changed. Refresh before retrying.');
    await this.events(db, row.id, transition);
    return { ...result.rows[0], ...(row.project ? { project: row.project } : {}) };
  }
  private async events(db: PoolClient, id: string, transition: EngineTransition) {
    const first = transition.state.lastSequence - transition.events.length + 1;
    for (const [i, event] of transition.events.entries())
      await db.query('INSERT INTO pbl_v3_events VALUES($1,$2,$3)', [
        id,
        first + i,
        JSON.stringify(event),
      ]);
  }
  agentStore(db: PoolClient) {
    return new PgAgentSessionStore(db, {
      withTransaction: (body) => body(db),
      onSessionEventAppended: (tx, event) =>
        notifyDurableAgentEvent(tx, { kind: 'session', sessionId: event.sessionId }),
      onCancelRequested: (tx, id) =>
        notifyDurableAgentEvent(tx, { kind: 'session', sessionId: id }),
    });
  }
}
