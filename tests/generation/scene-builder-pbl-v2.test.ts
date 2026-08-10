import { describe, expect, it } from 'vitest';

import { buildCompleteScene } from '@openmaic/generation';
import type { GeneratedPBLContent, SceneOutline } from '@/lib/types/generation';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';

describe('buildCompleteScene — PBL v2', () => {
  it('preserves projectV2 on the final scene content', () => {
    const outline: SceneOutline = {
      id: 'outline-pbl-v2',
      type: 'pbl',
      title: 'Scenario PBL',
      description: 'Practice a role-play scenario.',
      keyPoints: ['listening'],
      order: 1,
      pblConfig: {
        projectTopic: 'Scenario PBL',
        projectDescription: 'Practice a role-play scenario.',
        targetSkills: ['listening'],
        scenarioRoleplay: true,
      },
    };
    const projectV2 = {
      title: 'Scenario PBL',
      scenario: {
        setting: 'A clinic consultation.',
        characters: [
          {
            id: 'char_1',
            name: 'Patient',
            persona: 'Concerned neighbor',
            situation: 'Has stomach discomfort.',
          },
        ],
      },
      roles: [{ id: 'role_instructor', type: 'instructor', name: 'Instructor' }],
      milestones: [
        {
          scenarioStage: 'prep',
          microtasks: [{ id: 'task_prep', title: 'Prepare for the scenario' }],
        },
      ],
      submissions: [],
      evaluations: [],
      threads: [],
      engagementEvents: [],
    } as unknown as PBLProjectV2;
    const content = {
      projectV2,
    } satisfies GeneratedPBLContent;

    const scene = buildCompleteScene(outline, content, [], 'stage-1');

    expect(scene?.content.type).toBe('pbl');
    if (scene?.content.type !== 'pbl') throw new Error('expected PBL scene');
    expect(scene.content.projectV2).toBe(projectV2);
    expect(scene.content).not.toHaveProperty('projectConfig');
    expect(scene.content.projectV2?.scenario).toBeTruthy();
  });
});
