vi.mock('server-only', () => ({}));
import { expect, it, vi } from 'vitest';
import { projectReportMilestones, projectReportSummary } from '@/lib/pbl/v3/report-summary';
import { reportProjectResults } from '@/lib/pbl/v3/report';
import { recordDecision } from '@/lib/pbl/v3/domain/orchestration/decisions';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
import { reportShareContent } from '@/lib/pbl/v3/report-share';
import type { LearningReport } from '@/lib/pbl/v3/report';

function reviewFixture() {
  const project = structuredClone(
    installedProject({ id: 'greeting-python', version: '1.0.0' }).definition,
  );
  const milestone = project.milestones[0]!;
  milestone.stages = [
    {
      kind: 'produce',
      agent: 'planner',
      writes: 'plan',
      reviewRequired: true,
      reads: [],
      studentActions: [],
    },
    {
      kind: 'produce',
      agent: 'coder',
      writes: 'code',
      reviewRequired: true,
      reads: [],
      studentActions: [],
    },
  ];
  return { project, milestone, state: startOrchestration(project).state };
}

it('retains practiced reviews after later edits invalidate current artifact approvals', () => {
  const { project, milestone, state } = reviewFixture();
  state.milestones[0]!.completedStageIndexes = [0, 1];
  const collected = state.collected[milestone.id]!;
  collected.planReviewCompleted = false;
  collected.codeReviewCompleted = false;
  collected.decisions = [{ id: 'choice', chosen: 'option', revision: 1 }];
  collected.tests = { status: 'passed' } as typeof collected.tests;
  collected.recapCompleted = true;
  const before = structuredClone(state);
  const summary = projectReportSummary(project, state);
  const workflow = ['decisions', 'planReview', 'codeReview', 'verification', 'reflection'];
  expect(summary.skills.map((skill) => skill.id)).toEqual(workflow);
  expect(
    reportShareContent({
      project: { title: project.title },
      requiredComplete: true,
      milestones: [],
      summary,
    } as unknown as LearningReport).workflow,
  ).toEqual(workflow);
  expect(state).toEqual(before);
});

it('counts only the review stage actually completed, without granting later review credit', () => {
  const { project, milestone, state } = reviewFixture();
  state.milestones[0]!.completedStageIndexes = [0, 0, -1, 999];
  expect(projectReportSummary(project, state).skills).toEqual([
    { id: 'planReview', milestoneIds: [milestone.id] },
  ]);
});

it('does not infer review from an unreviewed produce stage or milestone completion alone', () => {
  const { project, state } = reviewFixture();
  const stage = project.milestones[0]!.stages[0]!;
  if (stage.kind === 'produce') stage.reviewRequired = false;
  state.milestones[0]!.completedStageIndexes = [0];
  state.milestones[0]!.status = 'completed';
  expect(projectReportSummary(project, state).skills).toEqual([]);
});

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

it('shows the authored result and each milestone’s latest real decision independently', () => {
  const project = structuredClone(
    installedProject({ id: 'greeting-python', version: '1.0.0' }).definition,
  );
  const first = project.milestones[0]!;
  const decision = project.decisions.find((item) => first.decisions.includes(item.id))!;
  const option = decision.options[0]!;
  option.previewLabel = 'Show the greeting on the page';
  first.goal = 'A visitor can enter a name and receive a greeting.';
  project.milestones.push({
    ...structuredClone(first),
    id: 'later',
    title: 'An unfinished extension',
    goal: 'Add more formatting.',
    decisions: [],
  });
  const state = startOrchestration(project).state;
  const firstState = state.collected[first.id]!;
  firstState.decisions = [
    ...recordDecision(
      recordDecision(firstState, decision.id, option.id, 'First draft'),
      decision.id,
      option.id,
      'The result is visible to the visitor.',
    ).decisions,
  ];
  state.milestones[0]!.status = 'completed';
  const milestones = projectReportMilestones(project, state);
  expect(reportProjectResults({ milestones }).map(({ title, goal }) => ({ title, goal }))).toEqual([
    { title: first.title, goal: first.goal },
  ]);
  expect(milestones[0]?.decisions).toEqual([
    {
      id: decision.id,
      question: decision.desc,
      answer: option.previewLabel,
      rationale: 'The result is visible to the visitor.',
    },
  ]);
  expect(milestones[1]?.decisions).toEqual([]);
});
