import { afterEach, describe, expect, it, vi } from 'vitest';
import { Check } from 'typebox/value';

import { MAX_REMOTE_IMAGE_BYTES } from '@/lib/server/bounded-download';

const mocks = vi.hoisted(() => ({
  recordGenerationUsage: vi.fn().mockResolvedValue(undefined),
  getServerPersistenceProvider: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/server/usage-storage', () => ({
  recordGenerationUsage: mocks.recordGenerationUsage,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: async () => null }));
vi.mock('@/lib/logger', () => ({ createLogger: () => mocks.log }));

import {
  buildGenerateImageTool,
  defaultPersistGeneratedImage,
  GenerateImageParams,
} from '@/lib/server/agent-runtime/generate-image';

describe('generate_image tool', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('validates prompt and the supported aspect ratios', () => {
    expect(
      Check(GenerateImageParams, {
        stageId: 'stage-owner',
        prompt: 'A microscope',
        aspectRatio: '16:9',
      }),
    ).toBe(true);
    expect(
      Check(GenerateImageParams, {
        stageId: 'stage-owner',
        prompt: 'A microscope',
        aspectRatio: '1:1',
      }),
    ).toBe(true);
    expect(
      Check(GenerateImageParams, {
        stageId: 'stage-owner',
        prompt: 'A microscope',
        aspectRatio: '4:3',
      }),
    ).toBe(true);
    expect(Check(GenerateImageParams, { prompt: 'A microscope', aspectRatio: '16:9' })).toBe(false);
    expect(
      Check(GenerateImageParams, { stageId: 'stage-owner', prompt: '', aspectRatio: '16:9' }),
    ).toBe(false);
    expect(
      Check(GenerateImageParams, {
        stageId: 'stage-owner',
        prompt: 'A microscope',
        aspectRatio: '9:16',
      }),
    ).toBe(false);
  });

  it('fails loudly when no server image provider is configured', async () => {
    const tool = buildGenerateImageTool({
      sessionId: 'session-owner',
      getConfiguredProviders: () => ({}),
    });

    const result = (await tool.execute(
      'call-1',
      { stageId: 'stage-owner', prompt: 'A microscope' },
      undefined,
    )) as {
      isError?: boolean;
      content: { text: string }[];
      details: Record<string, unknown>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no server image provider is available');
    expect(result.details).toMatchObject({
      stageId: 'stage-owner',
      sessionId: 'session-owner',
      reason: 'no-provider',
    });
  });

  it('fails loudly when the server resolves no model for a model-bearing provider', async () => {
    const generateConfiguredImage = vi.fn();
    const tool = buildGenerateImageTool({
      sessionId: 'session-owner',
      getConfiguredProviders: () => ({ 'openai-image': { models: [] } }),
      resolveProviderConfig: () => ({
        providerId: 'openai-image',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: undefined,
      }),
      generateConfiguredImage,
    });

    const result = (await tool.execute(
      'call-1',
      { stageId: 'stage-owner', prompt: 'A microscope' },
      undefined,
    )) as { isError?: boolean; content: { text: string }[]; details: Record<string, unknown> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no model is configured');
    expect(result.details.reason).toBe('missing-model');
    // Never a silent adapter default: the provider is not called.
    expect(generateConfiguredImage).not.toHaveBeenCalled();
  });

  it('honors a pre-aborted tool call before resolving owner scope or doing I/O', async () => {
    const controller = new AbortController();
    controller.abort();
    const generateConfiguredImage = vi.fn();
    const tool = buildGenerateImageTool({
      getConfiguredProviders: () => ({ 'openai-image': {} }),
      generateConfiguredImage,
    });

    await expect(
      tool.execute('call-1', { stageId: 'stage-owner', prompt: 'A microscope' }, controller.signal),
    ).rejects.toThrow('aborted');
    expect(generateConfiguredImage).not.toHaveBeenCalled();
  });

  it('generates, persists and returns a renderable src under the bound course scope', async () => {
    vi.stubEnv('DEFAULT_IMAGE_PROVIDER', 'openai-image');
    const generated = {
      base64: Buffer.from('real-image-bytes').toString('base64'),
      width: 1024,
      height: 576,
    };
    const generateConfiguredImage = vi.fn().mockResolvedValue(generated);
    const put = vi.fn().mockResolvedValue('ast_generated-image');
    mocks.getServerPersistenceProvider.mockResolvedValue({ assetStore: { put } });
    const tool = buildGenerateImageTool({
      sessionId: 'session-owner',
      getConfiguredProviders: () => ({ 'openai-image': { models: ['gpt-image-1'] } }),
      resolveProviderConfig: () => ({
        providerId: 'openai-image',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-image-1',
      }),
      generateConfiguredImage,
    });

    const result = (await tool.execute(
      'call-1',
      {
        stageId: 'stage-owner',
        prompt: 'A microscope',
        aspectRatio: '16:9',
        styleHint: 'editorial photo',
      },
      undefined,
    )) as {
      isError?: boolean;
      content: { text: string }[];
      details: { src: string; width: number; height: number };
    };

    expect(result.isError).toBeUndefined();
    expect(generateConfiguredImage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai-image',
        model: 'gpt-image-1',
      }),
      expect.objectContaining({
        prompt: 'A microscope\nStyle direction: editorial photo',
        aspectRatio: '16:9',
        stageId: 'stage-owner',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(put).toHaveBeenCalledWith(
      { key: 'shared' },
      expect.objectContaining({ size: Buffer.from('real-image-bytes').length, type: 'image/png' }),
      { contentType: 'image/png' },
    );
    // Success details are provider-neutral: no provider id leaks into the
    // transcript. The vendor choice stays in the server-side log, correlated
    // by the tool-call id.
    expect(result.details).toEqual({
      src: 'ast_generated-image',
      width: 1024,
      height: 576,
    });
    expect(result.content[0].text).toContain(result.details.src);
    expect(mocks.recordGenerationUsage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', quantity: 1 }),
    );
    expect(mocks.log.info).toHaveBeenCalledWith(
      expect.stringMatching(/call-1[\s\S]*provider=openai-image/),
    );
  });

  it('fails loudly when the generated image exceeds the byte cap', async () => {
    const oversized = {
      base64: Buffer.alloc(MAX_REMOTE_IMAGE_BYTES + 1).toString('base64'),
      width: 1024,
      height: 576,
    };
    const put = vi.fn();
    await expect(
      defaultPersistGeneratedImage(
        {
          result: oversized,
          stageId: 'stage-owner',
          signal: new AbortController().signal,
        },
        { put },
      ),
    ).rejects.toThrow(`exceeds the ${MAX_REMOTE_IMAGE_BYTES}-byte limit`);
    expect(put).not.toHaveBeenCalled();
  });

  it('materializes a provider-hosted URL through the shared asset registry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(Buffer.from('real-image-bytes'), {
          headers: { 'content-type': 'image/jpeg' },
        }),
      ),
    );
    const put = vi.fn().mockResolvedValue('ast_provider-image');
    await expect(
      defaultPersistGeneratedImage(
        {
          result: { url: 'https://cdn.example.com/generated/photo.jpg', width: 1024, height: 576 },
          stageId: 'stage-owner',
          signal: new AbortController().signal,
        },
        { put },
      ),
    ).resolves.toBe('ast_provider-image');
    expect(put).toHaveBeenCalledWith(
      { key: 'shared' },
      expect.objectContaining({ size: Buffer.from('real-image-bytes').length, type: 'image/jpeg' }),
      { contentType: 'image/jpeg' },
    );
  });

  it('skips a force-disabled provider in the selector even when it has a key', async () => {
    const generateConfiguredImage = vi.fn().mockResolvedValue({
      base64: Buffer.from('real-image-bytes').toString('base64'),
      width: 1024,
      height: 576,
    });
    const put = vi.fn().mockResolvedValue('ast_generated-image');
    mocks.getServerPersistenceProvider.mockResolvedValue({ assetStore: { put } });
    const tool = buildGenerateImageTool({
      sessionId: 'session-owner',
      // openai-image is force-disabled (`{ disabled: true }`); seedream is the
      // only enabled entry, so the selector must pick seedream (#665).
      getConfiguredProviders: () => ({
        'openai-image': { disabled: true, models: ['gpt-image-1'] },
        seedream: { models: ['doubao-seedream-3-0-t2i-250415'] },
      }),
      resolveProviderConfig: () => ({
        providerId: 'seedream',
        apiKey: 'test-key',
        baseUrl: 'https://ark.cn-beijing.volces.com',
        model: 'doubao-seedream-3-0-t2i-250415',
      }),
      generateConfiguredImage,
    });

    const result = (await tool.execute(
      'call-1',
      { stageId: 'stage-owner', prompt: 'A microscope' },
      undefined,
    )) as { isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(generateConfiguredImage).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'seedream' }),
      expect.anything(),
    );
  });

  it('does not select a force-disabled provider via DEFAULT_IMAGE_PROVIDER', async () => {
    vi.stubEnv('DEFAULT_IMAGE_PROVIDER', 'openai-image');
    const generateConfiguredImage = vi.fn();
    const tool = buildGenerateImageTool({
      sessionId: 'session-owner',
      // openai-image is configured but force-disabled; the env default names it,
      // so the call must fail instead of using the disabled provider (#665).
      getConfiguredProviders: () => ({ 'openai-image': { disabled: true } }),
      generateConfiguredImage,
    });

    const result = (await tool.execute(
      'call-1',
      { stageId: 'stage-owner', prompt: 'A microscope' },
      undefined,
    )) as { isError?: boolean; content: { text: string }[]; details: Record<string, unknown> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('server default image provider is not available');
    expect(result.details.reason).toBe('no-provider');
    expect(generateConfiguredImage).not.toHaveBeenCalled();
  });

  it('keeps provider identity and raw errors out of tool results (server log only)', async () => {
    const generateConfiguredImage = vi
      .fn()
      .mockRejectedValue(new Error('s3://internal-bucket-xyz quota exceeded'));
    const tool = buildGenerateImageTool({
      sessionId: 'session-owner',
      getConfiguredProviders: () => ({ 'openai-image': { models: ['gpt-image-1'] } }),
      resolveProviderConfig: () => ({
        providerId: 'openai-image',
        apiKey: 'test-key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-image-1',
      }),
      generateConfiguredImage,
    });

    const result = (await tool.execute(
      'call-1',
      { stageId: 'stage-owner', prompt: 'A microscope' },
      undefined,
    )) as { isError?: boolean; content: { text: string }[]; details: Record<string, unknown> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Image generation failed.');
    expect(result.content[0].text).not.toContain('openai-image');
    expect(result.content[0].text).not.toContain('internal-bucket');
    expect(result.details).toEqual({ stageId: 'stage-owner', reason: 'provider-or-storage-error' });
    // The provider id and the raw exception stay in the server-side log,
    // correlated by the tool-call id.
    expect(mocks.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/call-1[\s\S]*provider=openai-image[\s\S]*internal-bucket/),
      expect.any(Error),
    );
  });
});
