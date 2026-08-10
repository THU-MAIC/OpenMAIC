import { describe, expect, it, vi } from 'vitest';
import type { GeneratedSceneContent, SceneOutline } from '@openmaic/generation';
import type { StageAPI } from '@/lib/api/stage-api';
import { createSceneWithActions } from '@/lib/server/scene-generation';

function outline(type: SceneOutline['type']): SceneOutline {
  return {
    id: `outline-${type}`,
    type,
    title: `${type} title`,
    description: `${type} description`,
    order: 2,
  } as SceneOutline;
}

function stageApi(result: { success: boolean; data?: string }) {
  const create = vi.fn(() => result);
  return {
    create,
    api: { scene: { create } } as unknown as StageAPI,
  };
}

describe('createSceneWithActions app adapter', () => {
  it.each([
    ['slide', { elements: [], background: '#fff' }, { type: 'slide' }],
    ['quiz', { questions: [] }, { type: 'quiz', questions: [] }],
    [
      'interactive',
      { html: '<main>Interactive</main>', widgetType: 'diagram', widgetConfig: { nodes: [] } },
      {
        type: 'interactive',
        url: '',
        html: '<main>Interactive</main>',
        widgetType: 'diagram',
        widgetConfig: { nodes: [] },
      },
    ],
    ['pbl', { projectV2: { title: 'Project' } }, { type: 'pbl', projectV2: { title: 'Project' } }],
  ] as const)('persists package-built %s scenes through StageAPI', (type, content, expected) => {
    const { api, create } = stageApi({ success: true, data: `scene-${type}` });
    const sceneOutline = outline(type);

    expect(
      createSceneWithActions(sceneOutline, content as unknown as GeneratedSceneContent, [], api),
    ).toBe(`scene-${type}`);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        type,
        title: sceneOutline.title,
        order: sceneOutline.order,
        outlineId: sceneOutline.id,
        actions: [],
        content: expect.objectContaining(expected),
      }),
    );
  });

  it('returns null when the store rejects the package-built scene', () => {
    const { api } = stageApi({ success: false });
    expect(
      createSceneWithActions(
        outline('quiz'),
        { questions: [] } as unknown as GeneratedSceneContent,
        [],
        api,
      ),
    ).toBeNull();
  });
});
