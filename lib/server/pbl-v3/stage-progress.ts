import {
  type StageDefinition,
  type ProjectDefinition,
} from '@/lib/pbl/v3/domain/project/project-schema';
import type { Study, RoleBinding } from './store';

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

/** Current-run failures without a teaching receipt remain retryable; no progress is granted. */
export function succeededWithoutTeachingReceipt(
  row: Pick<Study, 'state'>,
  stage: StageDefinition,
  binding: RoleBinding | undefined,
  status: string | undefined,
  latestUserSeq: number | undefined,
): boolean {
  const key = `${row.state.position.milestoneId}:${row.state.position.stageIndex}`;
  return (
    status === 'succeeded' &&
    !!latestUserSeq &&
    binding?.stage_key === key &&
    (stage.kind === 'mentor_say' || stage.kind === 'produce') &&
    !hasStageCompletion(row, stage, binding) &&
    binding.guided?.pending?.runId !== `${key}:${latestUserSeq}` &&
    binding.guided?.handoff?.runId !== `${key}:${latestUserSeq}`
  );
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
