import 'server-only';
import { LearningStore, type Study } from './store';
import { SandboxService } from '@/lib/server/sandbox/service';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import {
  withLearningWorkspaceAccess,
  learningWorkspaceId,
} from '@/lib/server/sandbox/managed-workspace';
import { SandboxError } from '@/lib/sandbox/errors';
import { fenceOwnerWrite } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { collectStudyExecution, saveStudyCheckpoint } from './runtime';
import {
  checkpointBusy,
  checkpointFailure,
  CheckpointAttemptError,
  type CheckpointStage,
} from '@/lib/server/sandbox/checkpoint-errors';
import {
  pblIdleTimeoutMs,
  pblArchiveFailureGraceMs,
  PBL_DIRTY_CHECKPOINT_MS,
  PBL_MAX_AGENT_TURN_MS,
  PBL_MAX_COMMAND_MS,
} from './lifecycle-config';

async function activeStudyTurns(store: LearningStore, id: string, ownerId: string) {
  return store.pool.query<{ id: string; status: string; turn_started: string }>(
    `SELECT a.id,a.status,(extract(epoch FROM r.turn_started_at)*1000)::text AS turn_started
 FROM pbl_v3_roles r JOIN agent_sessions a ON a.id=r.session_id
 WHERE r.study_id=$1 AND a.owner_id=$2 AND a.status IN ('queued','running')`,
    [id, ownerId],
  );
}

async function cancelOverdueTurns(agents: { id: string; turn_started: string }[]) {
  for (const agent of agents) {
    if (Date.now() - Number(agent.turn_started) <= PBL_MAX_AGENT_TURN_MS) continue;
    const sessions = await getAgentSessionStore();
    await sessions.requestCancel(agent.id);
    await sessions.claimNextSession(`pbl-lifecycle:${process.pid}`, process.pid, {
      sessionId: agent.id,
      leaseTtlMs: agentRuntimeConfig.leaseTtlMs,
      maxAttempts: agentRuntimeConfig.maxAttempts,
    });
  }
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
  await service.renew(environmentId);
  await store.pool.query(
    'UPDATE pbl_v3_studies SET environment_checked_at=clock_timestamp() WHERE id=$1 AND environment_id=$2',
    [id, environmentId],
  );
}

function archiveGraceExpired(row: Study) {
  const failed = row.checkpoint_failure;
  return (
    failed?.environmentId === row.environment_id &&
    !!failed.firstIdleFailureAt &&
    Date.now() - row.last_used_at.getTime() >= pblIdleTimeoutMs() &&
    Date.now() - Date.parse(failed.firstIdleFailureAt) >= pblArchiveFailureGraceMs()
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
  if (row.archive_discard?.environmentId === environmentId || archiveGraceExpired(row)) return;
  const recent = Date.now() - row.last_used_at.getTime() < pblIdleTimeoutMs();
  if (!recent) {
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
        new Date(Date.now() - PBL_MAX_COMMAND_MS),
        new Date(Date.now() - pblIdleTimeoutMs()),
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
  if (Date.now() - row.last_used_at.getTime() < pblIdleTimeoutMs()) return;
  if (archiveGraceExpired(row)) return releaseWithoutArchive(store, row, service);
  await store.recordCheckpointFailure(row, {
    environmentId: row.environment_id!,
    reason: 'execution-unsettled',
    stage,
    retryable: true,
    firstIdleFailureAt: row.checkpoint_failure?.firstIdleFailureAt ?? new Date().toISOString(),
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
    await cancelOverdueTurns(running.rows);
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
          if (env.state === 'destroyed') return;
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
            if (Date.now() - row.last_used_at.getTime() >= pblIdleTimeoutMs())
              await service.destroy(environmentId);
            return;
          }
          // Cover collection/export with a fresh provider lease, even after the last tab closes.
          if (!archiveGraceExpired(row))
            await renewForMaintenance(store, service, id, environmentId);
          const agents = await activeStudyTurns(store, id, ownerId);
          await cancelOverdueTurns(agents.rows);
          // A terminal result is persisted once by SandboxService.command, including lost start acknowledgements.
          const commands = await store.pool.query<{ id: string; created_at: Date }>(
            `SELECT id,created_at FROM sandbox_commands WHERE environment_id=$1
           AND (result_json IS NULL OR result_json->>'state' IN ('starting','running','unknown'))`,
            [environmentId],
          );
          let commandsBusy = 0,
            overdueCommands = 0;
          for (const command of commands.rows) {
            const observed = await service
              .command(environmentId, command.id)
              .catch(() => ({ state: 'unknown' }));
            if (['starting', 'running', 'unknown'].includes(observed.state)) {
              commandsBusy++;
              if (Date.now() - command.created_at.getTime() > PBL_MAX_COMMAND_MS) {
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
            const collected = await collectStudyExecution(store, row, service);
            if ('pending' in collected.result) return;
            row = await store.transaction((db) => store.commit(db, row, collected.transition));
            await store.recordActivity(id, ownerId);
            row = await store.get(id, ownerId);
          }
          const idle = Date.now() - row.last_used_at.getTime() >= pblIdleTimeoutMs();
          if (
            idle ||
            (row.workspace_dirty_at &&
              Date.now() - row.workspace_dirty_at.getTime() >= PBL_DIRTY_CHECKPOINT_MS)
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
            if (archiveGraceExpired(row) && failure) {
              await releaseWithoutArchive(store, row, service);
              return;
            }
            const dirtyAt = row.workspace_dirty_at?.toISOString() ?? null;
            // A file/configuration limit is not repaired by repeatedly uploading the same workspace.
            if (failure && !failure.retryable && failure.dirtyAt === dirtyAt) {
              if (idle && !failure.firstIdleFailureAt)
                await store.recordCheckpointFailure(row, {
                  ...failure,
                  firstIdleFailureAt: new Date().toISOString(),
                });
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
                  failure?.firstIdleFailureAt ?? (idle ? new Date().toISOString() : null),
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
  return store.exclusive(id, maintain, 'maintenance').catch(async (error: unknown) => {
    if (error instanceof SandboxError && error.code === 'PBL_BUSY' && currentEnvironmentId)
      await renewDeferredStudy(store, id, ownerId, currentEnvironmentId);
    throw error;
  });
}

export async function maintainLearningEnvironments() {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const existing = await pool.query<{ ready: boolean }>(
    "SELECT to_regclass('pbl_v3_studies') IS NOT NULL AND to_regclass('sandbox_environments') IS NOT NULL AS ready",
  );
  if (!existing.rows[0]?.ready) return;
  const store = await LearningStore.open();
  const rows = await store.pool.query<{ id: string; owner_id: string; environment_id: string }>(
    `SELECT s.id,s.owner_id,e.id AS environment_id FROM pbl_v3_studies s JOIN sandbox_environments e
       ON (e.id=s.environment_id OR e.id=s.environment_recovery->>'requestId')
     WHERE e.state<>'destroyed' ORDER BY e.updated_at LIMIT 100`,
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      for (;;) {
        const row = rows.rows[next++];
        if (!row) return;
        try {
          await maintainStudy(store, row.id, row.owner_id, row.environment_id);
        } catch (error) {
          if (!(error instanceof SandboxError && [409, 429].includes(error.status)))
            console.warn('[pbl-lifecycle] Study reconciliation deferred', { studyId: row.id });
        }
      }
    }),
  );
}
