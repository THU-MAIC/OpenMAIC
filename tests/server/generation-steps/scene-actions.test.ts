import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateSceneActions } from '@/lib/server/generation/steps/scene-actions';
import type { SceneOutline } from '@/lib/types/generation';

import { fakeModel, jsonRequest, testLogger, withoutMintedValues } from './helpers';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  resolveModelFromRequest: vi.fn(),
  generateSceneActions: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));
vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateSceneActions: mocks.generateSceneActions,
}));

const model = fakeModel();

const outline = (id: string, order: number, title: string): SceneOutline => ({
  id,
  order,
  type: 'slide',
  title,
  description: title,
  keyPoints: [],
});

const body = {
  outline: outline('o2', 2, 'Second'),
  allOutlines: [outline('o1', 1, 'First'), outline('o2', 2, 'Second'), outline('o3', 3, 'Third')],
  content: { elements: [] },
  stageId: 'stage-1',
  previousSpeeches: ['Welcome back.'],
  userProfile: 'A curious learner',
  languageDirective: 'Teach in English.',
};

describe('scene actions step', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveModelFromRequest.mockReset();
    mocks.resolveModelFromRequest.mockResolvedValue(model);
    mocks.generateSceneActions.mockReset();
    mocks.generateSceneActions.mockResolvedValue([
      { id: 'a1', type: 'speech', text: 'Now the second part.' },
      { id: 'a2', type: 'speech', text: 'Let us look closer.' },
    ]);
  });

  it("generates in the scene's place in the course and hands its speeches on", async () => {
    const result = await generateSceneActions({ ...body, model }, { log: testLogger() });

    const [, , , options] = mocks.generateSceneActions.mock.calls[0]!;
    expect(options).toEqual({
      ctx: {
        pageIndex: 2,
        totalPages: 3,
        allTitles: ['First', 'Second', 'Third'],
        previousSpeeches: ['Welcome back.'],
      },
      agents: undefined,
      userProfile: 'A curious learner',
      languageDirective: 'Teach in English.',
    });
    expect(result.scene).toMatchObject({ stageId: 'stage-1', type: 'slide', title: 'Second' });
    expect(result.previousSpeeches).toEqual(['Now the second part.', 'Let us look closer.']);
  });

  it('answers the route exactly as the step does', async () => {
    const { POST } = await import('@/app/api/generate/scene-actions/route');
    const response = await POST(jsonRequest('http://localhost/api/generate/scene-actions', body));
    expect(response.status).toBe(200);
    const routed = await response.json();

    const stepped = await generateSceneActions({ ...body, model }, { log: testLogger() });
    expect(withoutMintedValues(routed)).toEqual(
      withoutMintedValues({ success: true, ...JSON.parse(JSON.stringify(stepped)) }),
    );
  });
});
