vi.mock('server-only', () => ({}));
import { expect, it, vi } from 'vitest';
import { projectReportSummary } from '@/lib/pbl/v3/report-summary';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';

it('counts committed steps and practiced concepts without inventing mastery or credit for later milestones', () => {
  const project = structuredClone(
    installedProject({ id: 'greeting-python', version: '1.0.0' }).definition,
  );
  const first = project.milestones[0]!;
  first.teaching = { purpose: 'Practice', concepts: ['Input', 'Output', 'Input'], boundaries: [] };
  project.milestones.push({
    ...structuredClone(first),
    id: 'later',
    teaching: { purpose: 'Later', concepts: ['Concurrency'], boundaries: [] },
  });
  const state = startOrchestration(project).state;
  expect(projectReportSummary(project, state).skills).toEqual([]);
  state.milestones[0]!.status = 'completed';
  state.milestones[1]!.completedStageIndexes = [0, 0, -1, 999];
  state.collected[first.id]!.planReviewCompleted = true;
  const summary = projectReportSummary(project, state);
  expect(summary).toMatchObject({
    completedMilestones: 1,
    totalMilestones: 2,
    completedSteps: first.stages.length + 1,
    totalSteps: first.stages.length * 2,
    concepts: ['Input', 'Output'],
  });
  expect(summary.skills).toEqual([{ id: 'planReview', milestoneIds: [first.id] }]);
});
