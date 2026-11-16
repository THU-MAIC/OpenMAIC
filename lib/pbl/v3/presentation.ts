import type { LearningView } from './types';

/** Hosted activity UI capabilities, shared with teaching guidance. */
export const learningWorkbenchFeatures = { executionConsole: false, applicationPreview: false };

/** Presentation-only navigation to the current task; never a decision submission. */
export const TASK_DRAWER_LINK = '#pbl-task';

export function hasTaskDrawer(view: Pick<LearningView, 'state' | 'stage'>): boolean {
  return view.state.status !== 'completed';
}

/** Labels follow authoritative progress; they never authorize a transition. */
export function learningStep(view: Pick<LearningView, 'state' | 'stage'>): string {
  return stageStep(view.stage);
}

export function stageStep(stage: LearningView['stage']): string {
  if (stage.kind === 'produce') return stage.writes;
  if (stage.kind === 'check') return stage.checker;
  if (stage.kind === 'mentor_say') return stage.agent === 'discussion' ? 'teaching' : 'recap';
  return stage.kind;
}

/** The next step within the current milestone. */
export function nextLearningStep(view: Pick<LearningView, 'state' | 'milestones'>) {
  return view.milestones?.[view.state.position.milestoneIndex]?.stages[
    view.state.position.stageIndex + 1
  ];
}

/** A milestone handoff requires a real current step and a following milestone. */
export function continuesToNextMilestone(
  {
    milestoneIndex,
    stageIndex,
  }: Pick<LearningView['state']['position'], 'milestoneIndex' | 'stageIndex'>,
  milestones: readonly { stages: readonly unknown[] }[] | undefined,
): boolean {
  const current = milestones?.[milestoneIndex];
  return (
    stageIndex >= 0 &&
    stageIndex === (current?.stages.length ?? 0) - 1 &&
    !!milestones?.[milestoneIndex + 1]
  );
}

export function continueActionLabel(
  view: Pick<LearningView, 'state' | 'milestones'>,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  const step = nextLearningStep(view);
  if (step) return t('pblV3.journey.enterStep', { step: t(`pblV3.journey.steps.${step}`) });
  return t(
    continuesToNextMilestone(view.state.position, view.milestones)
      ? 'pblV3.journey.enterMilestone'
      : 'pblV3.next',
  );
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
