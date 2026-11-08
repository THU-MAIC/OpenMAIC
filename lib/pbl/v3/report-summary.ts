import type { ProjectDefinition } from './domain/project/project-schema';
import type { PblSessionState } from './domain/orchestration/types';
import { reportTextExcerpt, type LearningReport } from './report';
import { stageStep } from './presentation';
import { decisionResponseLabel } from './domain/orchestration/decisions';

/** Completion receipts support participation claims, not inferred expertise or rankings. */
export function projectReportSummary(
  project: ProjectDefinition,
  state: PblSessionState,
): NonNullable<LearningReport['summary']> {
  const completed = project.milestones.filter(
    (m) => state.milestones.find((p) => p.milestoneId === m.id)?.status === 'completed',
  );
  const criteria = {
    decisions: (id: string) => !!state.collected[id]?.decisions.length,
    planReview: (id: string) => state.collected[id]?.planReviewCompleted === true,
    codeReview: (id: string) => state.collected[id]?.codeReviewCompleted === true,
    verification: (id: string) => state.collected[id]?.tests?.status === 'passed',
    reflection: (id: string) => state.collected[id]?.recapCompleted === true,
  };
  return {
    completedMilestones: completed.length,
    totalMilestones: project.milestones.length,
    completedSteps: project.milestones.reduce((n, m) => {
      const p = state.milestones.find((p) => p.milestoneId === m.id);
      return (
        n +
        (p?.status === 'completed'
          ? m.stages.length
          : new Set(p?.completedStageIndexes.filter((i) => i >= 0 && i < m.stages.length) ?? [])
              .size)
      );
    }, 0),
    totalSteps: project.milestones.reduce((n, m) => n + m.stages.length, 0),
    concepts: [...new Set(completed.flatMap((m) => m.teaching?.concepts ?? []))],
    skills: Object.entries(criteria).flatMap(([id, supports]) => {
      const milestoneIds = project.milestones.filter((m) => supports(m.id)).map((m) => m.id);
      return milestoneIds.length
        ? [
            {
              id: id as NonNullable<LearningReport['summary']>['skills'][number]['id'],
              milestoneIds,
            },
          ]
        : [];
    }),
  };
}

/** Derive authored milestones and their latest actual choices without reading analysis or sampled events. */
export function projectReportMilestones(
  project: ProjectDefinition,
  state: PblSessionState,
): LearningReport['milestones'] {
  const excerpt = (value: string) =>
    value.length > 480 ? reportTextExcerpt(value, 479) + '…' : value;
  const definitions = new Map(project.decisions.map((decision) => [decision.id, decision]));
  return project.milestones.map((milestone) => ({
    id: milestone.id,
    title: milestone.title,
    ...(milestone.goal ? { goal: excerpt(milestone.goal) } : {}),
    ...(milestone.shareResult ? { shareResult: milestone.shareResult } : {}),
    optional: !!milestone.optional,
    status:
      state.milestones.find((progress) => progress.milestoneId === milestone.id)?.status ??
      'pending',
    stages: milestone.stages.map(stageStep),
    decisions: (state.collected[milestone.id]?.decisions ?? []).flatMap((record) => {
      const decision = definitions.get(record.id);
      if (!decision) return [];
      const option =
        decision.responseType === 'text'
          ? undefined
          : decision.options.find((item) => item.id === record.chosen);
      return [
        {
          id: record.id,
          question: excerpt(decision.desc),
          answer: excerpt(option?.previewLabel ?? decisionResponseLabel(decision, record.chosen)),
          ...(record.rationale?.trim() ? { rationale: excerpt(record.rationale) } : {}),
        },
      ];
    }),
  }));
}
