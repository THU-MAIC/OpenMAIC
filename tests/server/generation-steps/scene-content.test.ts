import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  generateSceneContent,
  type SceneContentInput,
} from '@/lib/server/generation/steps/scene-content';
import type { PdfImage, SceneOutline } from '@/lib/types/generation';

import { fakeModel, testLogger } from './helpers';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  generateSceneContent: vi.fn(),
  resolveVisionImagesStub: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateSceneContent: mocks.generateSceneContent,
}));

const visionModel = fakeModel({
  modelInfo: { outputWindow: 4096, capabilities: { vision: true } } as never,
});

const outline: SceneOutline = {
  id: 'o1',
  order: 1,
  type: 'slide',
  title: 'Leaves',
  description: 'How leaves work',
  keyPoints: ['stomata'],
  suggestedImageIds: ['img_2', 'img_1'],
};

const image = (id: string, pageNumber: number): PdfImage => ({
  id,
  src: '',
  pageNumber,
  description: `figure ${id}`,
});

const body = {
  outline,
  allOutlines: [outline],
  pdfImages: [image('img_1', 1), image('img_2', 2), image('img_3', 3)],
  imageMapping: { img_1: 'asset-1', img_2: 'asset-2', img_3: 'asset-3' },
  stageInfo: { name: 'Plants' },
  stageId: 'stage-1',
  languageDirective: 'Teach in English.',
};

const content = { elements: [], remark: 'generated' };

describe('scene content step', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.generateSceneContent.mockReset();
    mocks.generateSceneContent.mockResolvedValue(content);
    mocks.resolveVisionImagesStub.mockReset();
    mocks.resolveVisionImagesStub.mockImplementation(
      async (images: { id: string; src: string }[]) =>
        images
          .filter((img) => img.src !== 'asset-2')
          .map((img) => ({ ...img, src: `data:image/png;base64,${img.id}` })),
    );
  });

  function input(): SceneContentInput {
    return {
      outline: body.outline,
      pdfImages: body.pdfImages,
      imageMapping: body.imageMapping,
      languageDirective: body.languageDirective,
      targetLanguage: '',
      model: visionModel,
    };
  }

  it("attaches the outline's images as resolved, dropping one that does not resolve", async () => {
    const resolveVisionImages = vi.fn(mocks.resolveVisionImagesStub);
    const result = await generateSceneContent(input(), { log: testLogger(), resolveVisionImages });

    expect(result).toEqual({ content, effectiveOutline: expect.objectContaining({ id: 'o1' }) });
    const [effectiveOutline, , options] = mocks.generateSceneContent.mock.calls[0]!;
    expect(effectiveOutline).toMatchObject({ title: 'Leaves', type: 'slide' });
    expect(options.visionEnabled).toBe(true);
    // Only the assigned images, in page order, minus the one that did not resolve.
    expect(options.assignedImages.map((img: PdfImage) => img.id)).toEqual(['img_1']);
    expect(options.imageMapping).toEqual({ img_1: 'asset-1', img_3: 'asset-3' });
    expect(options.resolvedVisionImages).toEqual([
      { id: 'img_1', src: 'data:image/png;base64,img_1' },
    ]);
    expect(options.targetLanguage).toBeUndefined();
  });

  it('refuses when the generator produces nothing', async () => {
    mocks.generateSceneContent.mockResolvedValue(null);
    const failure = await generateSceneContent(input(), {
      log: testLogger(),
      resolveVisionImages: mocks.resolveVisionImagesStub,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StepRefusal);
    expect(failure).toMatchObject({
      reason: 'generation-failed',
      message: 'Failed to generate content: Leaves',
    });
  });
});
