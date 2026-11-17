import {
  type StageDefinition,
  type ProjectDefinition,
} from '@/lib/pbl/v3/domain/project/project-schema';
import type { Study, RoleBinding } from './store';
import type { LearningView } from '@/lib/pbl/v3/types';
import { executionFailureCode } from '@/lib/agent/runtime/request-failure';
import { learningRunFailure } from './conversation';
import type { TeachingTurnDelivery } from './conversation-history';

export function requiresArtifactApproval(stage: StageDefinition): boolean {
  return stage.kind === 'produce' && stage.reviewRequired;
}

/** Report access follows the final committed project recap. */
export function canViewProjectReport(state: Study['state']): boolean {
  return state.status === 'completed';
}

/** A completed review belongs to a stage and its evidence, not the latest chat message. */
export function hasStageCompletion(
  row: Pick<Study, 'state'>,
  stage: StageDefinition,
  binding: Pick<RoleBinding, 'stage_key' | 'completion'> | undefined,
): boolean {
  const key = `${row.state.position.milestoneId}:${row.state.position.stageIndex}`;
  if (binding?.stage_key !== key || binding.completion?.stageKey !== key) return false;
  const collected = row.state.collected[row.state.position.milestoneId ?? ''];
  if (!collected) return false;
  if (stage.kind === 'mentor_say')
    return stage.agent === 'discussion'
      ? !!collected.teachingCompleted
      : !!collected.recapCompleted;
  if (stage.kind === 'produce')
    return (
      !!collected[stage.writes] &&
      (!stage.reviewRequired ||
        !!(stage.writes === 'plan' ? collected.planReviewCompleted : collected.codeReviewCompleted))
    );
  return false;
}

/**
 * Current-run failures without a teaching receipt remain retryable; no progress is granted.
 * A turn that finished before a checkpoint restore reset progress keeps its own verdict:
 * the restore, not the turn, removed its receipt.
 */
export function succeededWithoutTeachingReceipt(
  row: Pick<Study, 'state'> & Partial<Pick<Study, 'environment_recovery'>>,
  stage: StageDefinition,
  binding: RoleBinding | undefined,
  status: string | undefined,
  latestUserSeq: number | undefined,
): boolean {
  return status === 'succeeded' && missingTeachingReceipt(row, stage, binding, latestUserSeq);
}

function missingTeachingReceipt(
  row: Pick<Study, 'state'> & Partial<Pick<Study, 'environment_recovery'>>,
  stage: StageDefinition,
  binding: RoleBinding | undefined,
  latestUserSeq: number | undefined,
): boolean {
  const key = `${row.state.position.milestoneId}:${row.state.position.stageIndex}`;
  const resetAt = row.environment_recovery?.progressResetAt;
  return (
    !!latestUserSeq &&
    binding?.stage_key === key &&
    !(resetAt && binding.turn_started_at.getTime() <= Date.parse(resetAt)) &&
    (stage.kind === 'mentor_say' || stage.kind === 'produce') &&
    !hasStageCompletion(row, stage, binding) &&
    binding.guided?.pending?.runId !== `${key}:${latestUserSeq}` &&
    binding.guided?.handoff?.runId !== `${key}:${latestUserSeq}`
  );
}

/** Command admission and the browser must agree on the current turn's recovery state. */
export function teachingRunState(
  row: Pick<Study, 'state'> & Partial<Pick<Study, 'environment_recovery'>>,
  stage: StageDefinition,
  binding: RoleBinding,
  meta: {
    status: NonNullable<LearningView['roleRun']>['status'];
    error?: unknown;
  } | null,
  delivery: TeachingTurnDelivery,
): NonNullable<LearningView['roleRun']> {
  const missingReceipt = missingTeachingReceipt(row, stage, binding, delivery.latestUserSeq);
  const unclosed = meta?.status === 'succeeded' && missingReceipt;
  const failure = unclosed
    ? 'incomplete'
    : meta?.status === 'failed'
      ? learningRunFailure(meta.error)
      : null;
  return {
    status: unclosed ? 'failed' : (meta?.status ?? 'missing'),
    canRetry: !!meta && (unclosed || ['failed', 'cancelled'].includes(meta.status)),
    failureCode: meta?.status === 'failed' ? executionFailureCode(meta.error) : null,
    failure,
    requiresReceiptRetry:
      missingReceipt &&
      (unclosed ||
        (meta?.status === 'failed' && failure === 'incomplete') ||
        (delivery.hasDeliveredText && (meta?.status === 'failed' || meta?.status === 'cancelled'))),
  };
}

/** Shared by tool completion and the teaching handoff; future release boundaries stay open. */
export function isFinalProjectRecap(
  project: ProjectDefinition,
  position: { milestoneIndex: number; stageIndex: number },
  stage: StageDefinition,
): boolean {
  return (
    stage.kind === 'mentor_say' &&
    stage.agent === 'mentor' &&
    position.milestoneIndex === project.milestones.length - 1 &&
    position.stageIndex === project.milestones[position.milestoneIndex]!.stages.length - 1
  );
}
