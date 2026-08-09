import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.name ? `${key}:${values.name}` : key,
    locale: 'en-US',
  }),
}));

import { PBLV2Hero } from '@/components/scene-renderers/pbl/v2/hero';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

function projectWithMalformedOptionalLeaves(): PBLProjectV2 {
  const project: PBLProjectV2 = {
    uiPhase: 'hero',
    title: 'Defensive readers',
    description: 'Malformed optional leaves stay inert.',
    proficiency: 'intermediate',
    language: 'en-US',
    tags: [],
    status: 'active',
    roles: [{ id: 'role-i', type: 'instructor', name: 'Instructor' }],
    milestones: [
      {
        id: 'ms-1',
        title: 'Milestone',
        status: 'active',
        order: 0,
        microtasks: [
          {
            id: 'mt-1',
            title: 'Task',
            status: 'todo',
            assignee: 'user',
            hints: [],
            order: 0,
          },
        ],
      },
    ],
    submissions: [],
    evaluations: [],
    threads: [{ agentId: 'role-i', messages: [] }],
    engagementEvents: [],
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
  };
  Reflect.set(project, 'gains', [42]);
  Reflect.set(project, 'proficiencyAssessment', {});
  return project;
}

describe('PBL v2 defensive leaf readers', () => {
  it('renders a container-valid project with malformed optional leaves', () => {
    const project = projectWithMalformedOptionalLeaves();

    expect(() =>
      renderToStaticMarkup(
        createElement(PBLV2Hero, {
          sceneId: 'scene-pbl',
          project,
          onProjectChange: vi.fn(),
        }),
      ),
    ).not.toThrow();
  });
});
