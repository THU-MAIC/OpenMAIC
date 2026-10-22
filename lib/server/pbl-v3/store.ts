import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { applySchemaMigrations } from '@openmaic/storage/pg-migrations';
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
import { resolveProject } from './project-resolver';

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
  ],
};

const admitted = new WeakMap<Pool, number>();

export class LearningStore {
  constructor(readonly pool: Pool) {}
  static async open() {
    const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    await getAgentSessionStore();
    await withSchemaBootstrapLock(pool, (db) => applySchemaMigrations(db, PBL_MIGRATIONS));
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
      // Scene bindings admit new studies; an existing journey uses its persisted pin.
      row.project = await resolveProject(ownerId, row.stage_id, row.project_reference);
    return row;
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
