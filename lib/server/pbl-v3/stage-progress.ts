import {
  isExplorationStage,
  type StageDefinition,
} from '@/lib/pbl/v3/domain/project/project-schema';
import type { Study, RoleBinding } from './store';

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

/** Also recognizes older text-only runs, so upgrading does not leave a learner
 * with neither a Continue button nor a Retry action. No progress is granted.
 */
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
    (stage.kind === 'mentor_say' || (stage.kind === 'produce' && !isExplorationStage(stage))) &&
    !hasStageCompletion(row, stage, binding) &&
    binding.guided?.pending?.runId !== `${key}:${latestUserSeq}`
  );
}
