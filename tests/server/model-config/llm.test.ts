import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SlotLookup } from '@/lib/server/model-config/runtime';
import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';
import type { ResolvedModel } from '@/lib/server/resolve-model';

const state = vi.hoisted(() => ({ lookup: undefined as SlotLookup | undefined }));

vi.mock('@/lib/server/model-config/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/model-config/runtime')>()),
  lookupStage: vi.fn(async () => state.lookup),
}));

const { lookupFromLayers, SlotDisabledError, SlotUnassignedError } =
  await import('@/lib/server/model-config/runtime');
const { resolveStageModel } = await import('@/lib/server/model-config/llm');

const layer = (source: ModelConfigLayer['source'], config: ModelConfigLayer['config']) => ({
  source,
  config,
});

const legacyModel = { modelString: 'openai:from-header' } as ResolvedModel;

describe('resolveStageModel', () => {
  beforeEach(() => {
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', '');
  });

  it('builds the configured model with its options', async () => {
    state.lookup = lookupFromLayers('course.content.slide', {
      deployment: null,
      workspace: layer('workspace', {
        providers: { ds: { preset: 'deepseek', apiKey: 'sk-user' } },
        slots: {
          'course.content': {
            model: 'ds:deepseek-v4-pro',
            thinking: { enabled: false },
            fallback: 'ds:deepseek-v4-flash',
          },
        },
      }),
      defaults: null,
    });
    const legacyRequest = vi.fn(async () => legacyModel);
    const resolved = await resolveStageModel({
      stage: 'scene-content:slide',
      workspaceId: 'user:alice',
      legacyRequest,
    });
    expect(resolved).toMatchObject({
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
      modelString: 'deepseek:deepseek-v4-pro',
      apiKey: 'sk-user',
      thinkingConfig: { enabled: false },
      serverManaged: true,
      resolution: { fallback: { modelId: 'deepseek-v4-flash' } },
    });
    // The request's own choice is not even looked at.
    expect(legacyRequest).not.toHaveBeenCalled();
  });

  it('fails loudly on a slot that is turned off, whatever the request names', async () => {
    state.lookup = lookupFromLayers('course.actions', {
      deployment: layer('deployment', { slots: { llm: null } }),
      workspace: null,
      defaults: null,
    });
    const legacyRequest = vi.fn(async () => legacyModel);
    await expect(
      resolveStageModel({ stage: 'scene-actions', workspaceId: null, legacyRequest }),
    ).rejects.toBeInstanceOf(SlotDisabledError);
    expect(legacyRequest).not.toHaveBeenCalled();
  });

  it('falls back to what the request names, then to the defaults', async () => {
    const defaults = layer('default', { slots: { llm: 'openai:gpt-5.6' } });
    const deployment = layer('deployment', {
      providers: { openai: { preset: 'openai', apiKey: 'sk-operator' } },
    });
    state.lookup = lookupFromLayers('course.outline', { deployment, workspace: null, defaults });
    expect(
      await resolveStageModel({
        stage: 'scene-outlines-stream',
        workspaceId: null,
        legacyRequest: async () => legacyModel,
      }),
    ).toBe(legacyModel);
    expect(
      await resolveStageModel({
        stage: 'scene-outlines-stream',
        workspaceId: null,
        legacyRequest: async () => undefined,
      }),
    ).toMatchObject({ modelId: 'gpt-5.6', apiKey: 'sk-operator' });
  });

  it('says so when nothing resolves', async () => {
    state.lookup = lookupFromLayers('llm', { deployment: null, workspace: null, defaults: null });
    await expect(
      resolveStageModel({ stage: 'generate-classroom', workspaceId: null }),
    ).rejects.toBeInstanceOf(SlotUnassignedError);
  });

  it('checks a workspace endpoint like a caller-supplied one, and trusts the deployment', async () => {
    const provider = {
      preset: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'local',
    };
    state.lookup = lookupFromLayers('llm', {
      deployment: null,
      workspace: layer('workspace', { providers: { local: provider }, slots: { llm: 'local:m' } }),
      defaults: null,
    });
    await expect(
      resolveStageModel({ stage: 'generate-classroom', workspaceId: 'u' }),
    ).rejects.toThrow(/Local\/private network URLs are not allowed/);
    state.lookup = lookupFromLayers('llm', {
      deployment: layer('deployment', {
        providers: { local: provider },
        slots: { llm: 'local:m' },
      }),
      workspace: null,
      defaults: null,
    });
    await expect(
      resolveStageModel({ stage: 'generate-classroom', workspaceId: null }),
    ).resolves.toMatchObject({ baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'm' });
  });
});
