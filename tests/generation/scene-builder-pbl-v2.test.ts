import { describe, expect, it } from 'vitest';

import { buildCompleteScene } from '@/lib/generation/scene-builder';
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
      milestones: [{ scenarioStage: 'prep', microtasks: [{}] }],
    } as unknown as PBLProjectV2;
    const content = {
      projectConfig: {
        projectInfo: { title: 'Scenario PBL', description: 'Legacy projection' },
        agents: [],
        issueboard: { agent_ids: [], issues: [] },
        chat: { messages: [] },
        selectedRole: null,
      },
      projectV2,
    } as unknown as GeneratedPBLContent;

    const scene = buildCompleteScene(outline, content, [], 'stage-1');

    expect(scene?.content.type).toBe('pbl');
    if (scene?.content.type !== 'pbl') throw new Error('expected PBL scene');
    expect(scene.content.projectV2).toBe(projectV2);
    expect(scene.content.projectV2?.scenario).toBeTruthy();
  });
});
