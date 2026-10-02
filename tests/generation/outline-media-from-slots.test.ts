/**
 * The outline step plans image and video only when the workspace's slots
 * offer them: a caller can only opt out.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { createLogger } from '@/lib/logger';

const mocks = vi.hoisted(() => ({
  streamLLM: vi.fn(),
  resolveModel: vi.fn(),
  capabilities: vi.fn(),
  buildOutlinePrompt: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/generation-capabilities', () => ({
  resolveServerGenerationCapabilities: mocks.capabilities,
}));
vi.mock('@openmaic/generation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openmaic/generation')>();
  return {
    ...actual,
    buildOutlinePrompt: (...args: Parameters<typeof actual.buildOutlinePrompt>) => {
      mocks.buildOutlinePrompt(...args);
      return actual.buildOutlinePrompt(...args);
    },
  };
});

async function planned(
  optOut: { allowImageGeneration?: boolean; allowVideoGeneration?: boolean } = {},
) {
  vi.resetModules();
  const { generateOutlines } = await import('@/lib/server/generation/steps/outline');
  // Only the planned media is asserted on, so how the stubbed stream ends does not matter.
  await generateOutlines(
    {
      requirements: { requirement: 'Teach photosynthesis.' },
      pdfText: '',
      pdfImages: [],
      imageMapping: {},
      researchContext: '',
      model: await mocks.resolveModel(),
      ...optOut,
    },
    {
      log: createLogger('Outline'),
      workspaceId: null,
      resolveVisionImages: async (images) => [...images],
    },
  ).catch(() => undefined);
  const [, context] = mocks.buildOutlinePrompt.mock.calls.at(-1) as [
    unknown,
    { imageGenerationEnabled?: boolean; videoGenerationEnabled?: boolean },
  ];
  return {
    image: context.imageGenerationEnabled,
    video: context.videoGenerationEnabled,
  };
}

beforeEach(() => {
  mocks.buildOutlinePrompt.mockReset();
  mocks.resolveModel.mockResolvedValue({
    model: { provider: 'test.chat', modelId: 'test-model' },
    modelInfo: { outputWindow: 4096, capabilities: {} },
    modelString: 'test:test-model',
    thinkingConfig: undefined,
  });
  mocks.streamLLM.mockImplementation(() => ({
    textStream: (async function* () {
      yield JSON.stringify({ languageDirective: 'English.', outlines: [] });
    })(),
  }));
});

describe('outline media planning', () => {
  test('follows the image and video slots when the caller says nothing', async () => {
    mocks.capabilities.mockResolvedValue({ imageGeneration: true, videoGeneration: false });
    expect(await planned()).toEqual({ image: true, video: false });
  });

  test('never turns on what the slots do not offer', async () => {
    mocks.capabilities.mockResolvedValue({ imageGeneration: false, videoGeneration: false });
    expect(await planned({ allowImageGeneration: true, allowVideoGeneration: true })).toEqual({
      image: false,
      video: false,
    });
  });

  test('lets a caller opt out explicitly', async () => {
    mocks.capabilities.mockResolvedValue({ imageGeneration: true, videoGeneration: true });
    expect(await planned({ allowImageGeneration: false })).toEqual({
      image: false,
      video: true,
    });
  });
});
