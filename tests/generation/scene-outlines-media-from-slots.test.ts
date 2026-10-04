/**
 * The outline route plans image and video only when the workspace's slots
 * offer them: the client no longer tells it, and a header can only opt out.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  streamLLM: vi.fn(),
  resolveModel: vi.fn(),
  capabilities: vi.fn(),
  buildOutlinePrompt: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModelFromRequest: mocks.resolveModel }));
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

function request(headers: Record<string, string> = {}) {
  return {
    json: async () => ({
      requirements: { requirement: 'Teach photosynthesis.' },
      pdfText: '',
      pdfImages: [],
      imageMapping: {},
      researchContext: '',
    }),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Parameters<
    typeof import('@/app/api/generate/scene-outlines-stream/route').POST
  >[0];
}

async function planned(headers?: Record<string, string>) {
  vi.resetModules();
  const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
  const response = await POST(request(headers));
  await response.text();
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
  test('follows the image and video slots with no header at all', async () => {
    mocks.capabilities.mockResolvedValue({ imageGeneration: true, videoGeneration: false });
    expect(await planned()).toEqual({ image: true, video: false });
  });

  test('never turns on what the slots do not offer', async () => {
    mocks.capabilities.mockResolvedValue({ imageGeneration: false, videoGeneration: false });
    expect(
      await planned({ 'x-image-generation-enabled': 'true', 'x-video-generation-enabled': 'true' }),
    ).toEqual({ image: false, video: false });
  });

  test('lets an API client opt out explicitly', async () => {
    mocks.capabilities.mockResolvedValue({ imageGeneration: true, videoGeneration: true });
    expect(await planned({ 'x-image-generation-enabled': 'false' })).toEqual({
      image: false,
      video: true,
    });
  });
});
