// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectOverview } from '@/components/scene-renderers/pbl/v3/project-overview';
import type { ProjectHeroDetails } from '@/lib/pbl/project-hero';
import type { LearningView } from '@/lib/pbl/v3/types';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const hero: ProjectHeroDetails = {
  title: 'Reliability project',
  description: 'Project-level goal.',
  finishedWork: 'Project-level finished application.',
  instructorName: 'Mentor',
  milestoneCount: 1,
  taskCount: 7,
};
type Milestones = NonNullable<LearningView['milestones']>;
const milestone: Milestones[number] = {
  id: 'one',
  title: 'Service recovery',
  optional: false,
  stages: [],
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(milestones: Milestones, projectHero = hero) {
  const view = { title: hero.title, milestones } as LearningView;
  await act(async () => root.render(createElement(ProjectOverview, { view, hero: projectHero })));
}
const occurrences = (text: string) => host.textContent!.split(text).length - 1;

it('preserves a single milestone goal and outcome that differ from the project summary', async () => {
  await render([
    {
      ...milestone,
      goal: 'Milestone-specific goal.',
      outcome: 'Milestone-specific outcome.',
      concepts: ['Bounded retries'],
      deliverables: ['A recoverable session'],
    },
  ]);
  for (const text of [
    hero.description,
    hero.finishedWork!,
    'Milestone-specific goal.',
    'Milestone-specific outcome.',
    'Bounded retries',
    'A recoverable session',
  ])
    expect(occurrences(text)).toBe(1);
});

it('omits only identical single-milestone goal and outcome summaries', async () => {
  await render([{ ...milestone, goal: hero.description, outcome: hero.finishedWork }]);
  expect(occurrences(hero.description)).toBe(1);
  expect(occurrences(hero.finishedWork!)).toBe(1);
});

it('keeps milestone text when project-level summaries are absent', async () => {
  await render([{ ...milestone, goal: 'Local goal.', outcome: 'Local outcome.' }], {
    ...hero,
    description: '',
    finishedWork: undefined,
  });
  expect(occurrences('Local goal.')).toBe(1);
  expect(occurrences('Local outcome.')).toBe(1);
});

it('preserves each milestone summary in multi-milestone projects', async () => {
  await render([
    { ...milestone, goal: hero.description, outcome: hero.finishedWork },
    { ...milestone, id: 'two', goal: 'Second goal.', outcome: 'Second outcome.' },
  ]);
  expect(occurrences(hero.description)).toBe(2);
  expect(occurrences(hero.finishedWork!)).toBe(2);
  expect(occurrences('Second goal.')).toBe(1);
  expect(occurrences('Second outcome.')).toBe(1);
});
