import { beforeEach, describe, expect, it, vi } from 'vitest';

// Agent media-tool force-off defense in depth (#665): mirror the capability
// route guards — a provider the operator force-disabled is rejected before any
// provider I/O even when a caller's listing omits the `{ disabled: true }`
// flag, and a disabled provider is never picked as the server default. The
// real server config is authoritative at the call boundary.

const mocks = vi.hoisted(() => ({
  recordGenerationUsage: vi.fn().mockResolvedValue(undefined),
  generateConfiguredImage: vi.fn(),
  generateConfiguredVideo: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/server/usage-storage', () => ({
  recordGenerationUsage: mocks.recordGenerationUsage,
}));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: async () => null }));
vi.mock('@/lib/logger', () => ({ createLogger: () => mocks.log }));

const CAP_ENV_PREFIXES = [
  'IMAGE_OPENAI',
  'IMAGE_SEEDREAM',
  'IMAGE_QWEN_IMAGE',
  'IMAGE_NANO_BANANA',
  'IMAGE_MINIMAX',
  'IMAGE_GROK',
  'IMAGE_LEMONADE',
  'IMAGE_COMFYUI',
  'VIDEO_SEEDANCE',
  'VIDEO_KLING',
  'VIDEO_VEO',
  'VIDEO_SORA',
  'VIDEO_MINIMAX',
  'VIDEO_GROK',
  'VIDEO_HAPPYHORSE',
];

function clearCapabilityEnv() {
  for (const prefix of CAP_ENV_PREFIXES) {
    delete process.env[`${prefix}_API_KEY`];
    delete process.env[`${prefix}_BASE_URL`];
    delete process.env[`${prefix}_MODELS`];
    delete process.env[`${prefix}_ENABLED`];
  }
}

describe('agent media tool force-off defense in depth (#665)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearCapabilityEnv();
    vi.clearAllMocks();
  });

  it('image: rejects a force-disabled provider at the call boundary even when the listing omits the flag', async () => {
    vi.stubEnv('IMAGE_OPENAI_API_KEY', 'sk-img');
    vi.stubEnv('IMAGE_OPENAI_ENABLED', 'false');
    const { buildGenerateImageTool } = await import('@/lib/server/agent-runtime/generate-image');

    const tool = buildGenerateImageTool({
      sessionId: 'session-owner',
      // The injected listing does NOT mark the provider disabled — the real
      // server force-off set must still stop the call.
      getConfiguredProviders: () => ({ 'openai-image': { models: ['gpt-image-1'] } }),
      resolveProviderConfig: () => ({
        providerId: 'openai-image',
        apiKey: 'sk-img',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-image-1',
      }),
      generateConfiguredImage: mocks.generateConfiguredImage,
    });

    const result = (await tool.execute(
      'call-1',
      { stageId: 'stage-owner', prompt: 'A microscope' },
      undefined,
    )) as { isError?: boolean; content: { text: string }[]; details: Record<string, unknown> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Image generation is unavailable.');
    expect(result.details).toMatchObject({ stageId: 'stage-owner', reason: 'provider-disabled' });
    expect(mocks.generateConfiguredImage).not.toHaveBeenCalled();
  });

  it('image: the default selector never picks a force-disabled provider', async () => {
    vi.stubEnv('IMAGE_OPENAI_API_KEY', 'sk-img');
    vi.stubEnv('IMAGE_OPENAI_ENABLED', 'false');
    const { buildGenerateImageTool } = await import('@/lib/server/agent-runtime/generate-image');

    const tool = buildGenerateImageTool({
      generateConfiguredImage: mocks.generateConfiguredImage,
    });

    const result = (await tool.execute(
      'call-1',
      { stageId: 'stage-owner', prompt: 'A microscope' },
      undefined,
    )) as { isError?: boolean; details: Record<string, unknown> };

    expect(result.isError).toBe(true);
    expect(result.details.reason).toBe('no-provider');
    expect(mocks.generateConfiguredImage).not.toHaveBeenCalled();
  });

  it('video: rejects a force-disabled provider at the call boundary even when the listing omits the flag', async () => {
    vi.stubEnv('VIDEO_GROK_API_KEY', 'xai-video');
    vi.stubEnv('VIDEO_GROK_ENABLED', 'false');
    const { buildGenerateVideoTool } = await import('@/lib/server/agent-runtime/generate-video');

    const tool = buildGenerateVideoTool({
      sessionId: 'session-owner',
      // The injected listing does NOT mark the provider disabled — the real
      // server force-off set must still stop the call.
      getConfiguredVideoProviders: () => ({ 'grok-video': { models: ['grok-imagine-video'] } }),
      resolveVideoProviderConfig: () => ({
        providerId: 'grok-video',
        apiKey: 'xai-video',
        baseUrl: 'https://api.x.ai/v1',
        model: 'grok-imagine-video',
      }),
      generateConfiguredVideo: mocks.generateConfiguredVideo,
    });

    const result = (await tool.execute(
      'call-1',
      { stageId: 'stage-owner', prompt: 'motion' },
      undefined,
    )) as { isError?: boolean; content: { text: string }[]; details: Record<string, unknown> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Video generation is unavailable.');
    expect(result.details).toMatchObject({ stageId: 'stage-owner', reason: 'provider-disabled' });
    expect(mocks.generateConfiguredVideo).not.toHaveBeenCalled();
  });

  it('video: the capability gate excludes a force-disabled provider from registration', async () => {
    vi.stubEnv('VIDEO_GROK_API_KEY', 'xai-video');
    vi.stubEnv('VIDEO_GROK_ENABLED', 'false');
    const { hasConfiguredVideoGeneration } =
      await import('@/lib/server/agent-runtime/generate-video');

    // Default wiring (real server config): the only configured provider is
    // force-disabled, so the gate must not register the tool.
    expect(hasConfiguredVideoGeneration()).toBe(false);
  });
});
