import 'server-only';
import { LearningStore, type Study } from './store';
import { SandboxService } from '@/lib/server/sandbox/service';
import { SandboxStore } from '@/lib/server/sandbox/store';
import { recordExpiredWorkspace } from './environment';
import {
  withLearningWorkspaceAccess,
  learningWorkspaceId,
} from '@/lib/server/sandbox/managed-workspace';
import { SandboxError } from '@/lib/sandbox/errors';
import { fenceOwnerWrite } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  collectStudyExecution,
  saveStudyCheckpoint,
  fileSnapshot,
  checkpointRecovery,
} from './runtime';
import {
  checkpointBusy,
  checkpointFailure,
  CheckpointAttemptError,
  type CheckpointStage,
  checkpointStep,
} from '@/lib/server/sandbox/checkpoint-errors';
import { CHECKPOINT_TIMEOUT_MS } from '@/lib/server/sandbox/checkpoint-policy';
import {
  pblIdleTimeoutMs,
  pblArchiveFailureGraceMs,
  PBL_DIRTY_CHECKPOINT_MS,
  PBL_MAX_COMMAND_MS,
} from './lifecycle-config';

async function activeStudyTurns(store: LearningStore, id: string, ownerId: string) {
  return store.pool.query<{ id: string }>(
    `SELECT a.id
 FROM pbl_v3_roles r JOIN agent_sessions a ON a.id=r.session_id
 WHERE r.study_id=$1 AND a.owner_id=$2 AND a.status IN ('queued','running')`,
    [id, ownerId],
  );
}

async function renewForMaintenance(
  store: LearningStore,
  service: SandboxService,
  id: string,
  environmentId: string,
) {
  // Do not endlessly renew compute when the control database cannot persist writes.
  await store.pool.query(
    'UPDATE pbl_v3_studies SET environment_checked_at=NULL WHERE id=$1 AND environment_id=$2',
    [id, environmentId],
  );
  await service.renewForCheckpoint(environmentId);
  await store.pool.query(
    'UPDATE pbl_v3_studies SET environment_checked_at=clock_timestamp() WHERE id=$1 AND environment_id=$2',
    [id, environmentId],
  );
}

function archiveGraceExpired(row: Study, now: Date) {
  const failed = row.checkpoint_failure;
  return (
    failed?.environmentId === row.environment_id &&
    !!failed.firstIdleFailureAt &&
    now.getTime() - row.last_used_at.getTime() >= pblIdleTimeoutMs() &&
    now.getTime() - Date.parse(failed.firstIdleFailureAt) >= pblArchiveFailureGraceMs()
  );
}

/** Keep live use leased when a slow checkpoint occupies maintenance admission. */
async function renewDeferredStudy(
  store: LearningStore,
  id: string,
  ownerId: string,
  environmentId: string,
) {
  const row = await store.get(id, ownerId);
  const now = await store.now();
  if (row.archive_discard?.environmentId === environmentId || archiveGraceExpired(row, now)) return;
  const withinRetention =
    now.getTime() - row.last_used_at.getTime() < pblIdleTimeoutMs() + pblArchiveFailureGraceMs();
  if (!withinRetention) {
    const work = await store.pool.query(
      `SELECT 1 FROM sandbox_commands WHERE environment_id=$1 AND (
         ((result_json IS NULL OR result_json->>'state' IN ('starting','running','unknown'))
           AND created_at >= $2)
         OR (result_json->>'state' IN ('exited','failed','cancelled','timed_out') AND updated_at >= $3))
       UNION ALL
       SELECT 1 FROM pbl_v3_roles r JOIN agent_sessions a ON a.id=r.session_id
         WHERE r.study_id=$4 AND a.status IN ('succeeded','failed','cancelled') AND a.updated_at >= $3
       LIMIT 1`,
      [
        environmentId,
        new Date(now.getTime() - PBL_MAX_COMMAND_MS),
        new Date(now.getTime() - pblIdleTimeoutMs()),
        id,
      ],
    );
    if (!work.rows.length) return;
  }
  const service = await SandboxService.forLearningMaintenance(id, ownerId, environmentId);
  await renewForMaintenance(store, service, id, environmentId);
}

async function releaseWithoutArchive(store: LearningStore, row: Study, service: SandboxService) {
  const environmentId = row.environment_id!;
  const saved = await service.checkpoint(environmentId);
  // This durable intent also fences edits if deletion is uncertain.
  await store.recordArchiveDiscard(row, {
    environmentId,
    at: new Date().toISOString(),
    checkpointRevision: saved?.revision ?? 0,
    checkpointAt: saved?.createdAt ?? null,
    reason: row.checkpoint_failure!.reason,
  });
  await service.destroy(environmentId);
}

async function handleUnsettledWriter(
  store: LearningStore,
  row: Study,
  service: SandboxService,
  stage: 'execution' | 'terminal',
) {
  const now = await store.now();
  if (now.getTime() - row.last_used_at.getTime() < pblIdleTimeoutMs()) return;
  if (archiveGraceExpired(row, now)) return releaseWithoutArchive(store, row, service);
  await store.recordCheckpointFailure(row, {
    environmentId: row.environment_id!,
    reason: 'execution-unsettled',
    stage,
    retryable: true,
    firstIdleFailureAt: row.checkpoint_failure?.firstIdleFailureAt ?? now.toISOString(),
    dirtyAt: row.workspace_dirty_at?.toISOString() ?? null,
  });
}

/** No browser timers, per-tab counts, or independently maintained busy flags. */
export async function maintainStudy(
  store: LearningStore,
  id: string,
  ownerId: string,
  pendingEnvironmentId?: string,
) {
  let periodic: Study | undefined;
  const initial = await store.get(id, ownerId);
  const currentEnvironmentId =
    pendingEnvironmentId ?? initial.environment_id ?? initial.environment_recovery?.requestId;
  const running = await activeStudyTurns(store, id, ownerId);
  if (currentEnvironmentId && running.rows.length) {
    // Model generation has no study lock. Keep its resource alive without taking that lock,
    // so skill reads and writes never lose a teaching turn to background maintenance.
    try {
      const service = await SandboxService.forLearningMaintenance(
        id,
        ownerId,
        currentEnvironmentId,
      );
      await renewForMaintenance(store, service, id, currentEnvironmentId);
    } catch (error) {
      if (!(error instanceof SandboxError && error.reason === 'ENVIRONMENT_BUSY'))
        console.warn('[pbl-lifecycle] Active task renewal deferred', {
          studyId: id,
          environmentId: currentEnvironmentId,
        });
    }
    return;
  }
  const maintain = async () => {
    let row = await store.get(id, ownerId);
    const environmentId =
      pendingEnvironmentId ?? row.environment_id ?? row.environment_recovery?.requestId;
    if (!environmentId) return;
    const service = await SandboxService.forLearningMaintenance(id, ownerId, environmentId);
    return withLearningWorkspaceAccess(
      {
        ownerId,
        workspaceId: learningWorkspaceId(id),
        environmentIds: () => [environmentId],
        operations: ['checkpoint', 'destroy'],
      },
      async () => {
        try {
          const env = await service.reconcile(environmentId, false);
          if (env.state === 'destroyed') {
            if (environmentId === row.environment_id)
              await recordExpiredWorkspace(store, row, service);
            return;
          }
          if (row.archive_discard?.environmentId === environmentId) {
            await service.destroy(environmentId);
            return;
          }
          if (env.state === 'destroying') {
            await service.destroy(environmentId);
            return;
          }
          if (env.state !== 'running') return;
          // An interrupted allocation/restore has acknowledged no new learner work.
          // Keep its identity for retry, and reclaim it even if an older environment is still bound.
          if (!env.workspaceReady || row.environment_id !== environmentId) {
            if ((await store.now()).getTime() - row.last_used_at.getTime() >= pblIdleTimeoutMs())
              await service.destroy(environmentId);
            return;
          }
          // Cover collection/export with a fresh provider lease, even after the last tab closes.
          if (!archiveGraceExpired(row, await store.now()))
            await renewForMaintenance(store, service, id, environmentId);
          const agents = await activeStudyTurns(store, id, ownerId);
          // A terminal result is persisted once by SandboxService.command, including lost start acknowledgements.
          const commands = await store.pool.query<{ id: string; created_at: Date }>(
            `SELECT id,created_at FROM sandbox_commands WHERE environment_id=$1
           AND (result_json IS NULL OR result_json->>'state' IN ('starting','running','unknown'))`,
            [environmentId],
          );
          let commandsBusy = 0,
            overdueCommands = 0;
          const commandNow = await store.now();
          for (const command of commands.rows) {
            const observed = await service
              .command(environmentId, command.id)
              .catch(() => ({ state: 'unknown' }));
            if (['starting', 'running', 'unknown'].includes(observed.state)) {
              commandsBusy++;
              if (commandNow.getTime() - command.created_at.getTime() > PBL_MAX_COMMAND_MS) {
                overdueCommands++;
                // Failure to acknowledge cancellation is still an unresolved writer, not a terminal result.
                await service.cancelCommand(environmentId, command.id).catch(() => {});
              }
            }
          }
          if (agents.rows.length) return;
          if (commandsBusy) {
            if (overdueCommands === commandsBusy)
              await handleUnsettledWriter(store, row, service, 'execution');
            return;
          }
          if (row.checkpoint_failure?.stage === 'execution') {
            await store.recordActivity(id, ownerId);
            await store.recordLifecycleError(id, ownerId, null);
          }
          // Terminal rows have stable updated_at values; repeated polls never extend inactivity.
          await store.transaction(async (db) => {
            await fenceOwnerWrite(db, ownerId);
            await db.query(
              `UPDATE pbl_v3_studies s SET last_used_at=GREATEST(s.last_used_at,
              (SELECT max(a.updated_at) FROM pbl_v3_roles r JOIN agent_sessions a ON a.id=r.session_id
               WHERE r.study_id=s.id AND a.status IN ('succeeded','failed','cancelled')),
              (SELECT max(c.updated_at) FROM sandbox_commands c WHERE c.environment_id=$2
               AND c.result_json->>'state' IN ('exited','failed','cancelled','timed_out')))
             WHERE s.id=$1 AND s.owner_id=$3`,
              [id, environmentId, ownerId],
            );
          });
          row = await store.get(id, ownerId);
          if (row.evaluation) {
            if (archiveGraceExpired(row, await store.now())) {
              await releaseWithoutArchive(store, row, service);
              return;
            }
            let collected;
            try {
              collected = await collectStudyExecution(store, row, service);
            } catch (error) {
              if (checkpointBusy(error)) return;
              const failedAt = await store.now();
              await store.recordCheckpointFailure(row, {
                environmentId,
                ...checkpointFailure(error),
                stage: 'collection',
                dirtyAt: row.workspace_dirty_at?.toISOString() ?? null,
                firstIdleFailureAt:
                  row.checkpoint_failure?.firstIdleFailureAt ??
                  (failedAt.getTime() - row.last_used_at.getTime() >= pblIdleTimeoutMs()
                    ? failedAt.toISOString()
                    : null),
              });
              return;
            }
            if ('pending' in collected.result) return;
            row = await store.transaction((db) => store.commit(db, row, collected.transition));
            if (!('interrupted' in collected.result)) await store.recordActivity(id, ownerId);
            row = await store.get(id, ownerId);
          }
          const now = await store.now();
          const idle = now.getTime() - row.last_used_at.getTime() >= pblIdleTimeoutMs();
          if (
            idle ||
            (row.workspace_dirty_at &&
              now.getTime() - row.workspace_dirty_at.getTime() >= PBL_DIRTY_CHECKPOINT_MS)
          ) {
            if (idle) {
              // An abandoned shell is a writer, not learner activity. Close it before taking
              // a file snapshot; failed discovery/cleanup uses the same finite failure grace.
              let terminalsClosed = true;
              try {
                for (const terminal of await service.listTerminals(environmentId)) {
                  if (terminal.state === 'closed') continue;
                  if (
                    (await service.closeTerminal(environmentId, terminal.id)).state !== 'closed'
                  ) {
                    terminalsClosed = false;
                    break;
                  }
                }
              } catch {
                terminalsClosed = false;
              }
              if (!terminalsClosed) {
                await handleUnsettledWriter(store, row, service, 'terminal');
                return;
              }
            }
            const failure =
              row.checkpoint_failure?.environmentId === environmentId
                ? row.checkpoint_failure
                : null;
            if (archiveGraceExpired(row, now) && failure) {
              await releaseWithoutArchive(store, row, service);
              return;
            }
            const dirtyAt = row.workspace_dirty_at?.toISOString() ?? null;
            // A file/configuration limit is not repaired by repeatedly uploading the same workspace.
            if (failure && !failure.retryable && failure.dirtyAt === dirtyAt) {
              if (idle && !failure.firstIdleFailureAt)
                await store.recordCheckpointFailure(row, {
                  ...failure,
                  firstIdleFailureAt: (await store.now()).toISOString(),
                });
              return;
            }
            if (!idle) {
              periodic = row;
              return;
            }
            let stage: CheckpointStage = 'archive';
            try {
              await saveStudyCheckpoint(service, row);
              stage = 'recovery';
              // Persist recovery position BEFORE deletion. A lost delete acknowledgement is retried by identity.
              await store.saveEnvironmentRecovery(row);
            } catch (error) {
              if (checkpointBusy(error)) return;
              const cause = checkpointFailure(error);
              const failureStage = error instanceof CheckpointAttemptError ? error.stage : stage;
              await store.recordCheckpointFailure(row, {
                environmentId,
                ...cause,
                stage: failureStage,
                dirtyAt,
                firstIdleFailureAt:
                  failure?.firstIdleFailureAt ?? (idle ? (await store.now()).toISOString() : null),
              });
              console.warn('[pbl-lifecycle] Checkpoint deferred', {
                studyId: id,
                environmentId,
                ...cause,
                stage: failureStage,
              });
              return;
            }
            if (idle) await service.destroy(environmentId);
          }
        } catch (error) {
          if (checkpointBusy(error)) return;
          await store.recordLifecycleError(id, ownerId, 'checkpoint-unavailable');
          // No SDK message/cause: provider exceptions may contain credentials and signed URLs.
          console.warn('[pbl-lifecycle] Workspace maintenance deferred', {
            studyId: id,
            environmentId,
          });
        }
      },
    );
  };
  await store.exclusive(id, maintain, 'maintenance').catch(async (error: unknown) => {
    if (error instanceof SandboxError && error.code === 'PBL_BUSY' && currentEnvironmentId)
      await renewDeferredStudy(store, id, ownerId, currentEnvironmentId);
    throw error;
  });
  if (periodic) await checkpointDirtyStudy(store, periodic);
}

/** Slow read/upload work owns a separate checkpoint lock; only publication needs the study lock. */
async function checkpointDirtyStudy(store: LearningStore, captured: Study) {
  const environmentId = captured.environment_id!;
  const unchanged = (current: Study) =>
    current.environment_id === environmentId &&
    current.revision === captured.revision &&
    current.workspace_dirty_at?.getTime() === captured.workspace_dirty_at?.getTime() &&
    current.archive_discard?.environmentId !== environmentId &&
    !current.evaluation &&
    (!current.environment_recovery || current.environment_recovery.requestId === environmentId);
  try {
    await store.periodicCheckpoint(captured.id, async (publish) => {
      const current = await store.get(captured.id, captured.owner_id);
      if (
        !unchanged(current) ||
        (await activeStudyTurns(store, current.id, current.owner_id)).rows.length
      )
        return;
      const service = await SandboxService.forLearningMaintenance(
        current.id,
        current.owner_id,
        environmentId,
      );
      await withLearningWorkspaceAccess(
        {
          ownerId: current.owner_id,
          workspaceId: learningWorkspaceId(current.id),
          environmentIds: () => [environmentId],
          operations: ['checkpoint'],
        },
        async () => {
          const signal = AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS);
          await service.renewForCheckpoint(environmentId, signal);
          await service.assertRecordedWorkspaceIdle(environmentId);
          const snapshot = await checkpointStep('snapshot', () =>
            fileSnapshot(service, current, signal),
          );
          const previous = await service.checkpoint(environmentId);
          const prepared = await checkpointStep('archive', () =>
            service.prepareWorkspaceCheckpoint(environmentId, previous?.revision ?? 0, signal),
          );
          try {
            await publish(async () => {
              const latest = await store.get(current.id, current.owner_id);
              if (
                !unchanged(latest) ||
                (await activeStudyTurns(store, latest.id, latest.owner_id)).rows.length
              )
                throw new SandboxError(
                  'CHECKPOINT_CHANGED',
                  409,
                  'Workspace changed during checkpoint.',
                );
              checkpointRecovery(latest, prepared.checkpoint.revision, snapshot.fingerprint);
              await prepared.commit((tx) => store.saveEnvironmentRecovery(latest, tx));
            });
          } finally {
            await prepared.discard().catch(() => {});
          }
        },
      );
    });
  } catch (error) {
    if (
      checkpointBusy(error) ||
      (error instanceof SandboxError &&
        (error.reason === 'STUDY_BUSY' || error.code === 'CHECKPOINT_CHANGED'))
    )
      return;
    await store.exclusive(captured.id, async () => {
      const latest = await store.get(captured.id, captured.owner_id);
      if (!unchanged(latest)) return;
      await store.recordCheckpointFailure(latest, {
        environmentId,
        ...checkpointFailure(error),
        stage: error instanceof CheckpointAttemptError ? error.stage : 'archive',
        dirtyAt: latest.workspace_dirty_at?.toISOString() ?? null,
        firstIdleFailureAt: latest.checkpoint_failure?.firstIdleFailureAt ?? null,
      });
    });
  }
}

export async function maintainLearningEnvironments(maintain = maintainStudy) {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const existing = await pool.query<{ ready: boolean }>(
    "SELECT to_regclass('pbl_v3_studies') IS NOT NULL AND to_regclass('sandbox_environments') IS NOT NULL AS ready",
  );
  if (!existing.rows[0]?.ready) return;
  const store = await LearningStore.open();
  await SandboxStore.open();
  const rows = await store.pool.query<{ id: string; owner_id: string; environment_id: string }>(
    `WITH candidates AS (SELECT s.id,s.owner_id,e.id AS environment_id FROM pbl_v3_studies s JOIN sandbox_environments e
       ON (e.id=s.environment_id OR e.id=s.environment_recovery->>'requestId')
     WHERE e.state<>'destroyed' AND e.owner_id=s.owner_id AND e.workspace_id='pbl-'||s.id
     ORDER BY e.maintenance_checked_at NULLS FIRST,e.id LIMIT 100 FOR UPDATE OF e SKIP LOCKED)
     UPDATE sandbox_environments e SET maintenance_checked_at=clock_timestamp()
       FROM candidates c WHERE e.id=c.environment_id RETURNING c.id,c.owner_id,e.id AS environment_id`,
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      for (;;) {
        const row = rows.rows[next++];
        if (!row) return;
        try {
          await maintain(store, row.id, row.owner_id, row.environment_id);
        } catch (error) {
          if (!(error instanceof SandboxError && [409, 429].includes(error.status)))
            console.warn('[pbl-lifecycle] Study reconciliation deferred', { studyId: row.id });
        }
      }
    }),
  );
}
