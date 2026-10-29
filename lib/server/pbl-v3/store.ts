import 'server-only';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import type { Queryable } from '@openmaic/storage/document/pg';
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
import type { ArchiveFailure, ArchiveDiscard } from '@/lib/pbl/v3/types';
import { pblIdleTimeoutMs, pblArchiveFailureGraceMs } from './lifecycle-config';

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
  last_used_at: Date;
  workspace_dirty_at: Date | null;
  lifecycle_error: string | null;
  checkpoint_failure: ArchiveFailure | null;
  archive_discard: ArchiveDiscard | null;
  idle_turn_cleanup: {
    environmentId: string;
    idleAt: string;
    releaseAt: string;
    releasing?: true;
  } | null;
  environment_recovery: {
    requestId: string;
    checkpointRevision?: number;
    progressReset?: boolean;
    /** Database time of the latest restore that rewound progress; earlier turns keep their verdict. */
    progressResetAt?: string;
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
  turn_started_at: Date;
  guided: import('./guided-review').GuidedSkillState | null;
  completion: { stageKey: string; feedbackSeq: number; userMessageSeq: number } | null;
}

const admitted = new WeakMap<Pool, number>();

export class LearningStore {
  constructor(readonly pool: Pool) {}
  async now(): Promise<Date> {
    return (await this.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
  }
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
  /** Activity is separate from teaching revisions; all tabs share the server clock. */
  async recordActivity(id: string, ownerId: string) {
    return this.transaction(async (db) => {
      await fenceOwnerWrite(db, ownerId);
      return (
        await db.query<Study>(
          `UPDATE pbl_v3_studies SET last_used_at=clock_timestamp(),checkpoint_failure=NULL,
           idle_turn_cleanup=CASE WHEN idle_turn_cleanup->>'releasing'='true' THEN idle_turn_cleanup ELSE NULL END
           WHERE id=$1 AND owner_id=$2 RETURNING *`,
          [id, ownerId],
        )
      ).rows[0];
    });
  }

  /** Short control transaction: no Study admission or remote I/O, including during a hung tool. */
  async reconcileIdleTurns(observed: Pick<Study, 'id' | 'owner_id'>) {
    return this.transaction(async (db) => {
      await fenceOwnerWrite(db, observed.owner_id);
      // Match teaching write order: agent lease first, then the Study row.
      const turns = await db.query<{ id: string; status: string }>(
        `SELECT a.id,a.status FROM pbl_v3_roles r JOIN agent_sessions a ON a.id=r.session_id
         WHERE r.study_id=$1 AND a.owner_id=$2 AND a.status IN ('queued','running')
         ORDER BY a.id FOR UPDATE OF a`,
        [observed.id, observed.owner_id],
      );
      const current = (
        await db.query<Study>(
          'SELECT * FROM pbl_v3_studies WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [observed.id, observed.owner_id],
        )
      ).rows[0];
      if (!current)
        throw new SandboxError('PBL_NOT_FOUND', 404, 'Learning session is unavailable.');
      const row = { ...observed, ...current };
      const now = (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
      if (!row.environment_id) return { row, active: turns.rows.length > 0, release: false };
      let cleanup = row.idle_turn_cleanup;
      if (cleanup?.environmentId !== row.environment_id) cleanup = null;
      // Learner inactivity is not execution failure. The runner settles failed
      // requests (including upstream silence); healthy queued/running work is protected.
      // Explicit release/discard intents below still fence retired writers.
      const release = !!cleanup && now.getTime() >= Date.parse(cleanup.releaseAt);
      const releasing = cleanup?.releasing === true;
      const discarded = row.archive_discard?.environmentId === row.environment_id;
      if (cleanup || row.archive_discard?.environmentId === row.environment_id) {
        const agents = this.agentStore(db);
        for (const turn of turns.rows)
          await agents.requestCancel(turn.id, {
            settle: release || releasing || discarded || turn.status === 'queued',
          });
        if (
          release &&
          !releasing &&
          turns.rows.some((turn) => turn.status === 'running') &&
          row.archive_discard?.environmentId !== row.environment_id
        ) {
          const saved = (
            await db.query<{ revision: number; created_at: Date }>(
              'SELECT revision,created_at FROM sandbox_workspace_checkpoints WHERE owner_id=$1 AND workspace_id=$2',
              [row.owner_id, `pbl-${row.id}`],
            )
          ).rows[0];
          row.archive_discard = {
            environmentId: row.environment_id,
            at: now.toISOString(),
            checkpointRevision: saved?.revision ?? 0,
            checkpointAt: saved?.created_at.toISOString() ?? null,
            reason: 'execution-unsettled',
          };
          await db.query(
            "UPDATE pbl_v3_studies SET archive_discard=$2,lifecycle_error='checkpoint-skipped' WHERE id=$1",
            [row.id, JSON.stringify(row.archive_discard)],
          );
        }
      }
      const active = cleanup
        ? (
            await db.query(
              `SELECT 1 FROM pbl_v3_roles r JOIN agent_sessions a ON a.id=r.session_id
             WHERE r.study_id=$1 AND a.status IN ('queued','running') LIMIT 1`,
              [row.id],
            )
          ).rows.length > 0
        : turns.rows.length > 0;
      return {
        row,
        active,
        release: releasing || row.archive_discard?.environmentId === row.environment_id,
      };
    });
  }

  async recordLifecycleError(id: string, ownerId: string, error: string | null) {
    await this.transaction(async (db) => {
      await fenceOwnerWrite(db, ownerId);
      await db.query('UPDATE pbl_v3_studies SET lifecycle_error=$3 WHERE id=$1 AND owner_id=$2', [
        id,
        ownerId,
        error,
      ]);
    });
  }

  async recordCheckpointFailure(row: Study, failure: ArchiveFailure) {
    await this.transaction(async (db) => {
      await fenceOwnerWrite(db, row.owner_id);
      await db.query(
        `UPDATE pbl_v3_studies SET checkpoint_failure=$4,lifecycle_error='checkpoint-unavailable'
         WHERE id=$1 AND owner_id=$2 AND environment_id=$3
           AND date_trunc('milliseconds',last_used_at)=$5
           AND (archive_discard IS NULL OR archive_discard->>'environmentId'<>$3)
           AND idle_turn_cleanup->>'releasing' IS DISTINCT FROM 'true'`,
        [row.id, row.owner_id, row.environment_id, JSON.stringify(failure), row.last_used_at],
      );
    });
  }

  /** A settled writer or collection ends its failure cycle without counting as learner activity. */
  async clearCheckpointFailure(row: Study, stage: ArchiveFailure['stage']) {
    await this.transaction(async (db) => {
      await fenceOwnerWrite(db, row.owner_id);
      // A returning learner already cleared checkpoint_failure but not its notice; clear both.
      await db.query(
        `UPDATE pbl_v3_studies SET checkpoint_failure=NULL,lifecycle_error=NULL
         WHERE id=$1 AND owner_id=$2 AND environment_id=$3
           AND (checkpoint_failure IS NULL OR checkpoint_failure->>'stage'=$4)
           AND (archive_discard IS NULL OR archive_discard->>'environmentId'<>$3)
           AND idle_turn_cleanup->>'releasing' IS DISTINCT FROM 'true'`,
        [row.id, row.owner_id, row.environment_id, stage],
      );
    });
  }

  /** Durable point of no return. Further writes must use a replacement environment. */
  async recordArchiveDiscard(
    row: Study,
    discard: ArchiveDiscard,
    onlyIfDirty = false,
    expectedLastUsedAt?: Date,
  ) {
    return this.transaction(async (db) => {
      await fenceOwnerWrite(db, row.owner_id);
      const updated = await db.query(
        `UPDATE pbl_v3_studies SET archive_discard=$4,lifecycle_error='checkpoint-skipped'
         WHERE id=$1 AND owner_id=$2 AND environment_id=$3
           AND (NOT $5::boolean OR (workspace_dirty_at IS NOT NULL AND revision=$6))
           AND ($7::timestamptz IS NULL OR date_trunc('milliseconds',last_used_at)=$7) RETURNING id`,
        [
          row.id,
          row.owner_id,
          row.environment_id,
          JSON.stringify(discard),
          onlyIfDirty,
          row.revision,
          expectedLastUsedAt ?? null,
        ],
      );
      return updated.rows.length > 0;
    });
  }

  /** Called under the study lock before dispatching an application writer.
   * Advance the archive fence on every start, without changing teaching evidence or editor revisions.
   */
  async markWorkspaceWriter(row: Study) {
    const updated = await this.transaction(async (db) => {
      await fenceOwnerWrite(db, row.owner_id);
      return db.query<Pick<Study, 'workspace_dirty_at'>>(
        `UPDATE pbl_v3_studies SET workspace_dirty_at=GREATEST(
           date_trunc('milliseconds',clock_timestamp()), workspace_dirty_at+interval '1 millisecond')
         WHERE id=$1 AND owner_id=$2 AND environment_id=$3 AND revision=$4
           AND idle_turn_cleanup->>'releasing' IS DISTINCT FROM 'true'
           AND (archive_discard IS NULL OR archive_discard->>'environmentId'<>$3)
         RETURNING workspace_dirty_at`,
        [row.id, row.owner_id, row.environment_id, row.revision],
      );
    });
    if (!updated.rows[0]) throw sandboxConflict('Workspace changed before application startup.');
    row.workspace_dirty_at = updated.rows[0].workspace_dirty_at;
  }

  /** Checkpoint metadata does not change teaching progress or invalidate an editor revision. */
  async saveEnvironmentRecovery(row: Study, db?: Queryable) {
    const save = async (db: Queryable) => {
      await fenceOwnerWrite(db, row.owner_id);
      const updated = await db.query(
        `UPDATE pbl_v3_studies SET environment_recovery=$4,workspace_dirty_at=$5,lifecycle_error=NULL,checkpoint_failure=NULL
         WHERE id=$1 AND owner_id=$2 AND environment_id=$3
           AND idle_turn_cleanup->>'releasing' IS DISTINCT FROM 'true'
           AND (archive_discard IS NULL OR archive_discard->>'environmentId'<>$3) RETURNING id`,
        [
          row.id,
          row.owner_id,
          row.environment_id,
          JSON.stringify(row.environment_recovery),
          row.workspace_dirty_at,
        ],
      );
      if (!updated.rows.length)
        throw new SandboxError('CHECKPOINT_CHANGED', 409, 'Workspace was released.');
    };
    if (db) await save(db);
    else await this.transaction(save);
  }
  /** Commit normal release only if no learner returned during checkpoint I/O. */
  async claimIdleRelease(row: Study) {
    return this.transaction(async (db) => {
      await fenceOwnerWrite(db, row.owner_id);
      const idleAt = row.last_used_at.getTime() + pblIdleTimeoutMs();
      const cleanup = {
        ...(row.idle_turn_cleanup ?? {
          environmentId: row.environment_id!,
          idleAt: new Date(idleAt).toISOString(),
          releaseAt: new Date(idleAt + pblArchiveFailureGraceMs()).toISOString(),
        }),
        releasing: true,
      };
      return (
        (
          await db.query(
            `UPDATE pbl_v3_studies s SET idle_turn_cleanup=$4
         WHERE s.id=$1 AND s.owner_id=$2 AND s.environment_id=$3
           AND date_trunc('milliseconds',s.last_used_at)=$5
           AND (s.archive_discard IS NULL OR s.archive_discard->>'environmentId'<>$3)
           AND NOT EXISTS(SELECT 1 FROM pbl_v3_roles r JOIN agent_sessions a ON a.id=r.session_id
             WHERE r.study_id=s.id AND a.status IN ('queued','running')) RETURNING id`,
            [row.id, row.owner_id, row.environment_id, JSON.stringify(cleanup), row.last_used_at],
          )
        ).rows.length > 0
      );
    });
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
  /** Bound pool admission and hold a cross-process study lock, including remote file I/O. */
  async exclusive<T>(
    id: string,
    fn: () => Promise<T>,
    mode: 'interactive' | 'maintenance' = 'interactive',
  ): Promise<T> {
    return this.admitted(`pbl-v3:${id}`, fn, mode);
  }

  /** A separate cross-process lock prevents duplicate periodic uploads without blocking study use. */
  async periodicCheckpoint<T>(
    id: string,
    fn: (publish: <R>(action: () => Promise<R>) => Promise<R>) => Promise<T>,
  ): Promise<T> {
    return this.admitted(
      `pbl-checkpoint:${id}`,
      () =>
        fn(async (action) => {
          // Retain the checkpoint mutex, but reuse its admission slot for short publication.
          // This also permits publication on injected pools with only one study slot.
          admitted.set(this.pool, (admitted.get(this.pool) ?? 1) - 1);
          try {
            return await this.exclusive(id, action);
          } finally {
            admitted.set(this.pool, (admitted.get(this.pool) ?? 0) + 1);
          }
        }),
      'maintenance',
    );
  }

  private async admitted<T>(
    key: string,
    fn: () => Promise<T>,
    mode: 'interactive' | 'maintenance',
  ) {
    const active = admitted.get(this.pool) ?? 0;
    const limit = Math.max(1, Math.floor((this.pool.options.max ?? 10) / 4));
    // Leave one slot for interactive work whenever the pool supports multiple slots.
    const capacity = mode === 'maintenance' ? Math.max(1, limit - 1) : limit;
    if (active >= capacity)
      throw new SandboxError(
        'PBL_BUSY',
        429,
        'Learning operations are busy. Retry shortly.',
        'STUDY_BUSY',
      );
    admitted.set(this.pool, active + 1);
    let db: PoolClient | undefined;
    let locked = false;
    let releaseError: Error | undefined;
    try {
      db = await this.pool.connect();
      locked = (
        await db.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
          [key],
        )
      ).rows[0]!.locked;
      if (!locked)
        throw sandboxConflict(
          'The learning session is busy. Retry after the current operation.',
          'STUDY_BUSY',
        );
      return await fn();
    } finally {
      try {
        if (locked) await db!.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error('Learning lock cleanup failed');
      } finally {
        db?.release(releaseError);
        admitted.set(this.pool, (admitted.get(this.pool) ?? 1) - 1);
      }
    }
  }

  /** Interactive work waits briefly for maintenance; no connection is held between attempts. */
  async waitForExclusive<T>(id: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      signal?.throwIfAborted();
      let entered = false;
      try {
        return await this.exclusive(id, () => {
          entered = true;
          return fn();
        });
      } catch (error) {
        if (
          entered ||
          !(error instanceof SandboxError) ||
          error.reason !== 'STUDY_BUSY' ||
          Date.now() >= deadline
        )
          throw error;
        await delay(50, undefined, { signal });
      }
    }
  }

  async commit(db: PoolClient, row: Study, transition: EngineTransition) {
    // Build collection commits before its caller returns. End its failure cycle atomically
    // with evaluation, so a later maintenance pass cannot discard successfully collected work.
    const collectionSettled = `evaluation->>'id' IS NOT NULL AND $5::jsonb='null'::jsonb
       AND environment_id=$4 AND checkpoint_failure->>'environmentId'=$4
       AND checkpoint_failure->>'stage'='collection' AND idle_turn_cleanup IS NULL
       AND archive_discard->>'environmentId' IS DISTINCT FROM environment_id`;
    const result = await db.query<Study>(
      `UPDATE pbl_v3_studies SET state=$3,revision=revision+1,environment_id=$4,evaluation=$5,environment_recovery=$6,
       workspace_dirty_at=CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE COALESCE(workspace_dirty_at,clock_timestamp()) END,
       lifecycle_error=CASE WHEN ${collectionSettled} THEN NULL ELSE $8 END,
       checkpoint_failure=CASE WHEN ${collectionSettled} THEN NULL ELSE checkpoint_failure END,
       idle_turn_cleanup=CASE WHEN environment_id IS DISTINCT FROM $4::text THEN NULL ELSE idle_turn_cleanup END
      WHERE id=$1 AND revision=$2
        AND archive_discard IS NOT DISTINCT FROM $9::jsonb
        AND (idle_turn_cleanup->>'releasing' IS DISTINCT FROM 'true' OR idle_turn_cleanup IS NOT DISTINCT FROM $10::jsonb) RETURNING *`,
      [
        row.id,
        row.revision,
        JSON.stringify(transition.state),
        row.environment_id,
        JSON.stringify(row.evaluation),
        JSON.stringify(row.environment_recovery),
        row.workspace_dirty_at ?? null,
        row.lifecycle_error ?? null,
        row.archive_discard ? JSON.stringify(row.archive_discard) : null,
        row.idle_turn_cleanup ? JSON.stringify(row.idle_turn_cleanup) : null,
      ],
    );
    if (!result.rows[0])
      throw sandboxConflict('Learning progress changed. Refresh before retrying.');
    await this.events(db, row.id, transition);
    return { ...result.rows[0], ...(row.project ? { project: row.project } : {}) };
  }
  private async events(db: PoolClient, id: string, transition: EngineTransition) {
    await notifyDurableAgentEvent(db, { kind: 'session', sessionId: id });
    const first = transition.state.lastSequence - transition.events.length + 1;
    for (const [i, event] of transition.events.entries())
      await db.query('INSERT INTO pbl_v3_events(study_id,sequence,event) VALUES($1,$2,$3)', [
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
