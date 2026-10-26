import 'server-only';
import type { SandboxService } from '@/lib/server/sandbox/service';
import { sandboxConflict } from '@/lib/sandbox/errors';
import { fileSnapshot, projectFor, requireEnvironment, stageFor, stageKey } from './runtime';
import type { LearningStore, Study } from './store';
import { checkpointFailure } from '@/lib/server/sandbox/checkpoint-errors';
import { invalidateWorkspace } from './runtime';

/** Absence of a reservation is definitive; lost start acknowledgements have a command row. */
export async function executionCommand(store: LearningStore, row: Study, service: SandboxService) {
  const found = await store.pool.query(
    'SELECT 1 FROM sandbox_commands WHERE environment_id=$1 AND id=$2',
    [requireEnvironment(row), row.evaluation!.id],
  );
  return found.rows.length ? service.command(requireEnvironment(row), row.evaluation!.id) : null;
}

export async function executionSnapshot(service: SandboxService, row: Study) {
  try {
    return await fileSnapshot(service, row);
  } catch (error) {
    if (checkpointFailure(error).reason === 'source-limit') return null;
    throw error;
  }
}

export async function startBuild(
  store: LearningStore,
  row: Study,
  service: SandboxService,
  id: string,
) {
  const stage = stageFor(row),
    command = projectFor(row).buildCommand;
  if (
    row.state.status === 'completed' ||
    !(
      (stage.kind === 'produce' && stage.writes === 'code') ||
      (stage.kind === 'check' &&
        stage.checker === 'tests' &&
        row.state.collected[row.state.position.milestoneId!]?.remediation?.target === 'coder')
    ) ||
    !command
  )
    throw sandboxConflict('No build is installed for this stage.');
  if (row.evaluation && (row.evaluation.purpose !== 'compile' || row.evaluation.id !== id))
    throw sandboxConflict('Collect the pending execution before starting another build.');
  if (row.evaluation)
    return service.startCommand(requireEnvironment(row), {
      requestId: id,
      command,
      timeoutMs: 60_000,
    });
  const snapshot = await fileSnapshot(service, row);
  row.evaluation ??= {
    id,
    fingerprint: snapshot.fingerprint,
    stageKey: stageKey(row),
    startedAt: new Date().toISOString(),
    purpose: 'compile',
  };
  Object.assign(
    row,
    await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] })),
  );
  return service.startCommand(requireEnvironment(row), {
    requestId: id,
    command,
    timeoutMs: 60_000,
  });
}
export async function collectBuild(store: LearningStore, row: Study, service: SandboxService) {
  const execution = row.evaluation;
  if (execution?.purpose !== 'compile') throw sandboxConflict('No build is awaiting collection.');
  const result = await executionCommand(store, row, service);
  if (!result) {
    row.evaluation = null;
    Object.assign(
      row,
      await store.transaction((db) => store.commit(db, row, invalidateWorkspace(row))),
    );
    return { stale: true, interrupted: true };
  }
  if (['starting', 'running', 'unknown'].includes(result.state)) return { pending: true };
  const snapshot = await executionSnapshot(service, row);
  if (!snapshot) {
    row.evaluation = null;
    Object.assign(
      row,
      await store.transaction((db) => store.commit(db, row, invalidateWorkspace(row))),
    );
    return { stale: true, interrupted: true };
  }
  const evidence = {
    kind: 'compile',
    revision: row.revision,
    commandId: execution.id,
    stageKey: execution.stageKey,
    fingerprint: execution.fingerprint,
    passed:
      result.state === 'exited' &&
      result.exitCode === 0 &&
      snapshot.fingerprint === execution.fingerprint &&
      stageKey(row) === execution.stageKey,
    output: (result.stdout + '\n' + result.stderr).slice(0, 8000),
  };
  row.evaluation = null;
  Object.assign(
    row,
    await store.transaction(async (db) => {
      await db.query(
        'INSERT INTO pbl_v3_commands(study_id,id,hash,result,stage_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(study_id,id) DO UPDATE SET result=EXCLUDED.result',
        [
          row.id,
          `build:${execution.id}`,
          execution.fingerprint,
          JSON.stringify(evidence),
          execution.stageKey,
        ],
      );
      return store.commit(db, row, { state: row.state, events: [] });
    }),
  );
  return evidence;
}
export async function assertBuilt(store: LearningStore, row: Study, fingerprint: string) {
  const stage = stageFor(row);
  if (stage.kind !== 'produce' || !stage.compileBeforeReview) return;
  const result = await store.pool.query<{ passed: string }>(
    "SELECT result->>'passed' AS passed FROM pbl_v3_commands WHERE study_id=$1 AND stage_key=$2 AND result->>'kind'='compile' AND result->>'fingerprint'=$3 ORDER BY (result->>'revision')::integer DESC LIMIT 1",
    [row.id, stageKey(row), fingerprint],
  );
  if (result.rows[0]?.passed !== 'true' || row.evaluation)
    throw sandboxConflict('Run and collect a successful build of the current files before review.');
}
