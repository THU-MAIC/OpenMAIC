import 'server-only';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { SandboxService } from '@/lib/server/sandbox/service';
import type { SandboxEnvironment } from '@/lib/sandbox/types';
import { SandboxError, sandboxConflict } from '@/lib/sandbox/errors';
import type { Study, LearningStore } from './store';
import { createCollectedMilestoneState } from '@/lib/pbl/v3/domain/orchestration/state';
import type { InstalledProject } from './catalog';

/** Throttle successful checks for 20 seconds; briefly recheck contention without replaying a teaching action. */
export async function touchEnvironment(store: LearningStore, row: Study, service: SandboxService) {
  if (!row.environment_id) return null;
  let env = await service.get(row.environment_id);
  const deadline = Date.now() + 5_000;
  let reconciled = false;
  for (;;) {
    // Polls and role tools use different service instances, possibly in different processes.
    // A caller's Study snapshot may predate another caller's successful renewal.
    const current = await store.get(row.id, row.owner_id);
    if (current.environment_id !== row.environment_id)
      throw sandboxConflict(
        'The learning environment changed. Refresh before continuing.',
        'ENVIRONMENT_CHANGED',
      );
    if (
      current.environment_checked_at &&
      Date.now() - current.environment_checked_at.getTime() < 20_000
    )
      return env;
    if (!reconciled) {
      env = await service.reconcile(env.id);
      reconciled = true;
    }
    if (env.state !== 'running' || !env.workspaceReady) return env;
    try {
      await service.renew(env.id);
    } catch (error) {
      if (
        !(error instanceof SandboxError) ||
        error.reason !== 'ENVIRONMENT_BUSY' ||
        Date.now() >= deadline
      )
        throw error;
      // No SQL connection or environment lock is retained while waiting. Mutation
      // locks and pool admission stay fail-fast; only this keepalive is retried.
      await delay(50);
      env = await service.get(row.environment_id);
      continue;
    }
    const updated = await store.pool.query(
      `UPDATE pbl_v3_studies SET environment_checked_at=now()
       WHERE id=$1 AND owner_id=$2 AND environment_id=$3 RETURNING id`,
      [row.id, row.owner_id, env.id],
    );
    if (!updated.rows.length)
      throw sandboxConflict(
        'The learning environment changed. Refresh before continuing.',
        'ENVIRONMENT_CHANGED',
      );
    return env;
  }
}
export function assertEnvironmentReady(env: SandboxEnvironment | null) {
  if (!env || env.state !== 'running' || !env.workspaceReady)
    throw sandboxConflict(
      'Prepare or recover the project environment before continuing.',
      'ENVIRONMENT_UNAVAILABLE',
    );
}

/** Revalidate artifact evidence and rewind across milestones if the restored checkpoint predates current work. */
export function recoveredProgress(
  row: Study,
  project: InstalledProject,
  files: Record<string, string>,
  checkpointRevision?: number,
) {
  const state = structuredClone(row.state);
  const saved = row.environment_recovery?.savedPosition;
  let crossedBoundary = false;
  let rewind = -1;
  if (checkpointRevision === 0 && state.position.milestoneIndex > 0) rewind = 0;
  else if (
    saved &&
    saved.revision === checkpointRevision &&
    saved.milestoneIndex < state.position.milestoneIndex
  )
    rewind = saved.milestoneIndex;
  if (rewind >= 0) {
    crossedBoundary = true;
    for (let i = rewind + 1; i < state.milestones.length; i++) {
      const progress = state.milestones[i]!;
      state.collected[progress.milestoneId] = createCollectedMilestoneState();
      Object.assign(progress, {
        status: 'pending',
        stageIndex: -1,
        completedStageIndexes: [],
        evaluationIds: [],
      });
    }
    const target = project.definition.milestones[rewind]!;
    const stageIndex =
      checkpointRevision === 0
        ? Math.max(
            0,
            target.stages.findIndex((s) => s.kind === 'produce'),
          )
        : saved!.stageIndex;
    state.status = 'waiting_for_student';
    state.position = { milestoneIndex: rewind, milestoneId: target.id, stageIndex };
    Object.assign(state.milestones[rewind]!, { status: 'active', stageIndex });
    state.milestones[rewind]!.completedStageIndexes = state.milestones[
      rewind
    ]!.completedStageIndexes.filter((i) => i < stageIndex);
  }
  const milestone = project.definition.milestones[state.position.milestoneIndex];
  const collected = milestone && state.collected[milestone.id];
  if (!collected || !state.introCompleted) return { state, reset: false };
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const fingerprint = hash(
    JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  );
  const planChanged =
    !!collected.plan && collected.plan.contentHash !== hash(files['PLAN.md'] ?? '');
  if (collected.plan && !planChanged) collected.plan.workspaceRevisionId = fingerprint;
  const codeChanged =
    planChanged || (!!collected.code && collected.code.workspaceRevisionId !== fingerprint);
  const testsChanged =
    codeChanged || (!!collected.tests && collected.tests.revision.id !== fingerprint);
  let restart = -1;
  if (planChanged) {
    collected.plan = null;
    collected.planReviewCompleted = false;
    restart = milestone.stages.findIndex((s) => s.kind === 'produce' && s.writes === 'plan');
  }
  if (codeChanged) {
    collected.code = null;
    collected.codeReviewCompleted = false;
    if (restart < 0)
      restart = milestone.stages.findIndex((s) => s.kind === 'produce' && s.writes === 'code');
  }
  if (testsChanged || row.evaluation) {
    collected.tests = null;
    collected.remediation = null;
    collected.quiz = null;
    collected.recapCompleted = false;
    if (restart < 0)
      restart = milestone.stages.findIndex((s) => s.kind === 'check' && s.checker === 'tests');
  }
  if (restart < 0) return { state, reset: crossedBoundary };
  // Never skip unfinished teaching on the way back to the first invalidated artifact.
  restart = Math.min(restart, state.position.stageIndex);
  state.status = 'waiting_for_student';
  state.position = {
    ...state.position,
    stageIndex: restart,
    activeAgent: undefined,
    activeAgentId: undefined,
  };
  const progress = state.milestones[state.position.milestoneIndex]!;
  progress.status = 'active';
  progress.stageIndex = restart;
  progress.completedStageIndexes = progress.completedStageIndexes.filter((i) => i < restart);
  progress.evaluationIds = [];
  return { state, reset: true };
}
