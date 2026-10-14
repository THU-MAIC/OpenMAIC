import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AICallFn } from '@openmaic/generation';

import { generateSceneActions } from '@/lib/server/generation/steps/scene-actions';
import type { SceneOutline } from '@/lib/types/generation';

import { fakeModel, testLogger } from './helpers';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  generateSceneActions: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
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
    mocks.generateSceneActions.mockReset();
    mocks.callLLM.mockReset();
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

  it('includes attachment labels only for images that survive preparation', async () => {
    const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'white' } })
      .png()
      .toBuffer();
    mocks.callLLM.mockResolvedValue({ text: 'Actions ready.' });
    mocks.generateSceneActions.mockImplementationOnce(
      async (_outline, _content, aiCall: AICallFn) => {
        await aiCall('Describe the slide.', 'Explain the diagram.', [
          { id: 'good', src: `data:image/png;base64,${png.toString('base64')}` },
          {
            id: 'bad',
            src: `data:image/png;base64,${Buffer.from('undecodable').toString('base64')}`,
          },
        ]);
        return [];
      },
    );
    await generateSceneActions(
      {
        ...body,
        model: fakeModel({
          modelInfo: { id: 'test-model', name: 'Test model', capabilities: { vision: true } },
        }),
      },
      { log: testLogger() },
    );
    const content = mocks.callLLM.mock.calls[0]![0].messages[0].content;
    expect(content.filter((part: { type: string }) => part.type === 'image')).toHaveLength(1);
    const text = content
      .filter((part: { type: string }) => part.type === 'text')
      .map((part: { text: string }) => part.text)
      .join('\n');
    expect(text).toContain('good');
    expect(text).not.toContain('bad');
  });
});
