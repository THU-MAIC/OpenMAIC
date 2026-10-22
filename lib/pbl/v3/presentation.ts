import type { LearningView } from './types';

/** Labels follow authoritative progress; they never authorize a transition. */
export function learningStep(view: Pick<LearningView, 'state' | 'stage'>): string {
  return stageStep(view.stage);
}

export function stageStep(stage: LearningView['stage']): string {
  if (stage.kind === 'produce') return stage.exploration ? 'explore' : stage.writes;
  if (stage.kind === 'check') return stage.checker;
  if (stage.kind === 'mentor_say') return stage.agent === 'discussion' ? 'teaching' : 'recap';
  return stage.kind;
}

/** Introduction is part of the first installed teaching step. */
export function learningProgress(view: Pick<LearningView, 'state' | 'stage' | 'milestones'>) {
  const milestone = view.milestones?.[view.state.position.milestoneIndex];
  const stages = milestone?.stages ?? [];
  const total = stages.length;
  const current = Math.min(total, Math.max(1, view.state.position.stageIndex + 1));
  const completed = view.state.milestones[view.state.position.milestoneIndex];
  return {
    current,
    total,
    steps: stages.map((stage, index) => ({
      label: stage,
      complete:
        completed?.status === 'completed' || !!completed?.completedStageIndexes?.includes(index),
      active: index === view.state.position.stageIndex && completed?.status !== 'completed',
    })),
  };
}
