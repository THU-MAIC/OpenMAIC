import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  generateSceneContent,
  type SceneContentInput,
} from '@/lib/server/generation/steps/scene-content';
import type { PdfImage, SceneOutline } from '@/lib/types/generation';

import { fakeModel, jsonRequest, testLogger } from './helpers';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  resolveModelFromRequest: vi.fn(),
  generateSceneContent: vi.fn(),
  resolveVisionImagesForPrompt: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));
vi.mock('@/lib/persistence/resolve-vision-images', () => ({
  resolveVisionImagesForPrompt: mocks.resolveVisionImagesForPrompt,
}));
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
    mocks.resolveModelFromRequest.mockReset();
    mocks.resolveModelFromRequest.mockResolvedValue(visionModel);
    mocks.generateSceneContent.mockReset();
    mocks.generateSceneContent.mockResolvedValue(content);
    mocks.resolveVisionImagesForPrompt.mockReset();
    mocks.resolveVisionImagesForPrompt.mockImplementation(
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
    const resolveVisionImages = vi.fn(mocks.resolveVisionImagesForPrompt);
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
      resolveVisionImages: mocks.resolveVisionImagesForPrompt,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StepRefusal);
    expect(failure).toMatchObject({
      reason: 'generation-failed',
      message: 'Failed to generate content: Leaves',
    });
  });

  it('answers the route exactly as the step does', async () => {
    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(jsonRequest('http://localhost/api/generate/scene-content', body));
    expect(response.status).toBe(200);
    const routedCall = mocks.generateSceneContent.mock.calls[0];
    const routed = await response.json();

    mocks.generateSceneContent.mockClear();
    const stepped = await generateSceneContent(input(), {
      log: testLogger(),
      resolveVisionImages: (images) => mocks.resolveVisionImagesForPrompt(images),
    });
    expect(routed).toEqual({ success: true, ...JSON.parse(JSON.stringify(stepped)) });
    expect(mocks.generateSceneContent.mock.calls[0]!.slice(0, 1)).toEqual(routedCall!.slice(0, 1));
    expect(mocks.generateSceneContent.mock.calls[0]![2]).toEqual(routedCall![2]);
  });

  it('answers a refusal with the 500 the route always answered', async () => {
    mocks.generateSceneContent.mockResolvedValue(null);
    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(jsonRequest('http://localhost/api/generate/scene-content', body));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      errorCode: 'GENERATION_FAILED',
      error: 'Failed to generate content: Leaves',
    });
  });
});
