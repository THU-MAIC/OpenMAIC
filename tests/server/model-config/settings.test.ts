import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';
import {
  applyModelSettingsChange,
  modelSettingsView,
  ModelSettingsError,
} from '@/lib/server/model-config/settings';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';

const deployment = (config: ModelConfigLayer['config']) =>
  setDeploymentConfigForTests({
    layer: { source: 'deployment', config },
    defaults: null,
    notices: [],
  });

beforeEach(() => {
  vi.stubEnv('ALLOW_LOCAL_NETWORKS', '');
  deployment({
    providers: { operator: { preset: 'deepseek', apiKey: 'sk-operator-secret-0001' } },
    slots: { llm: 'operator:deepseek-v4-pro', video: null },
  });
});

afterEach(() => {
  setDeploymentConfigForTests();
  vi.unstubAllEnvs();
});

describe('modelSettingsView', () => {
  it('shows the tree with effective models, locks and masked keys, and no secrets', () => {
    const view = modelSettingsView({
      config: {
        providers: { mine: { preset: 'openai', apiKey: 'sk-workspace-secret-9876' } },
        slots: { 'course.content': 'mine:gpt-5.6' },
      },
      revision: 3,
      unreadableSecrets: [],
    });
    const json = JSON.stringify(view);
    expect(json).not.toContain('sk-operator-secret');
    expect(json).not.toContain('sk-workspace-secret');
    expect(view.revision).toBe(3);
    expect(view.providers.map(({ capabilities: _capabilities, ...rest }) => rest)).toEqual([
      { id: 'operator', preset: 'deepseek', source: 'deployment' },
      { id: 'mine', preset: 'openai', source: 'workspace', key: { set: true, mask: '…9876' } },
    ]);
    // Each provider lists the models it serves per capability, for the pickers.
    expect(view.providers[0].capabilities.chat?.models).toContainEqual(
      expect.objectContaining({ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }),
    );
    // With what the registry knows of each model, and the entry that serves it.
    expect(view.providers[0].capabilities.chat?.registryId).toBe('deepseek');
    expect(
      view.providers[0].capabilities.chat?.models.find((model) => model.id === 'deepseek-v4-pro')
        ?.capabilities,
    ).toMatchObject({ tools: true });
    const slot = (id: string) => view.slots.find((entry) => entry.slot === id)!;
    expect(slot('llm')).toMatchObject({ locked: true, effective: { source: 'deployment' } });
    expect(slot('video')).toMatchObject({ locked: true, effective: { status: 'disabled' } });
    expect(slot('course.content.slide')).toMatchObject({
      locked: false,
      effective: { status: 'assigned', resolvedAt: 'course.content', modelId: 'gpt-5.6' },
    });
    expect(slot('course.content')).toMatchObject({ assignment: 'mine:gpt-5.6' });
    expect(slot('agent.title')).toMatchObject({ configOnly: true });
  });

  it('lists the presets a workspace may add, without deployment-only ones', () => {
    const presets = modelSettingsView(null).presets;
    const ids = presets.map((preset) => preset.id);
    expect(ids).toContain('openai');
    expect(ids).toContain('tavily');
    for (const deploymentOnly of [
      'bedrock',
      'searxng',
      'mineru',
      'comfyui-image',
      'funasr-asr',
      'alidocmind',
    ]) {
      expect(ids).not.toContain(deploymentOnly);
    }
    const compatible = presets.find((preset) => preset.id === 'openai-compatible')!;
    expect(compatible).toMatchObject({ requiresBaseUrl: true, customEndpoint: true });
    expect(presets.find((preset) => preset.id === 'tavily')).toMatchObject({
      customEndpoint: false,
    });

    deployment({ policy: { allowWorkspaceProviders: false } });
    expect(modelSettingsView(null).presets).toEqual([]);
  });

  it('names no deployment endpoint anywhere in the view', () => {
    deployment({
      providers: {
        operator: {
          preset: 'openai-compatible',
          apiKey: 'sk-operator',
          baseUrl: 'https://gateway.internal.example/v1?token=endpoint-secret',
          models: ['m1', 'm2'],
        },
      },
      slots: { llm: { model: 'operator:m1', fallback: 'operator:m2' } },
    });
    const json = JSON.stringify(modelSettingsView(null));
    expect(json).not.toContain('gateway.internal');
    expect(json).not.toContain('endpoint-secret');
  });

  it("offers an OpenAI-compatible deployment provider's listed models for chat", () => {
    deployment({
      providers: {
        gateway: {
          preset: 'openai-compatible',
          apiKey: 'sk-operator',
          baseUrl: 'https://gateway.example/v1',
          models: ['gpt-5.1', 'gpt-5.4-mini', 'deepseek-v4-flash-0731'],
        },
      },
    });
    const gateway = modelSettingsView(null).providers.find((entry) => entry.id === 'gateway')!;
    expect(gateway).toMatchObject({ source: 'deployment', preset: 'openai-compatible' });
    expect(gateway.capabilities.chat?.models.map((model) => model.id)).toEqual([
      'gpt-5.1',
      'gpt-5.4-mini',
      'deepseek-v4-flash-0731',
    ]);
  });

  it('never shows credentials a stored endpoint carries', () => {
    const view = modelSettingsView({
      config: {
        providers: {
          oc: {
            preset: 'openai-compatible',
            apiKey: 'sk-k',
            baseUrl: 'https://u:hunter2@1.1.1.1/v1',
          },
        },
        slots: { llm: 'oc:m1' },
      },
      revision: 1,
      unreadableSecrets: [],
    });
    expect(JSON.stringify(view)).not.toContain('hunter2');
  });

  it("offers a workspace provider's models only where the calls can reach them", () => {
    const view = modelSettingsView({
      config: {
        providers: {
          mm: { preset: 'minimax', apiKey: 'sk-k', baseUrl: 'https://1.1.1.1/v1' },
          oc: { preset: 'openai-compatible', apiKey: 'sk-k', baseUrl: 'https://1.1.1.1/v1' },
        },
      },
      revision: 1,
      unreadableSecrets: [],
    });
    const provider = (id: string) => view.providers.find((entry) => entry.id === id)!;
    // Its own endpoint serves chat only.
    expect(Object.keys(provider('mm').capabilities)).toEqual(['chat']);
    // An OpenAI-compatible server's models are the ones the provider lists.
    expect(provider('oc').capabilities.chat?.models).toEqual([]);
  });

  it('neither offers nor accepts a provider the operator switched off', async () => {
    vi.stubEnv('TTS_OPENAI_ENABLED', 'false');
    vi.stubEnv('TTS_MINIMAX_ENABLED', 'false');
    // The switch is read once per module load.
    vi.resetModules();
    const { modelSettingsView, applyModelSettingsChange } =
      await import('@/lib/server/model-config/settings');
    (await import('@/lib/server/model-config/runtime')).setDeploymentConfigForTests({
      layer: null,
      defaults: null,
      notices: [],
    });
    const view = modelSettingsView(null);
    expect(
      view.presets.find((preset) => preset.id === 'openai-tts')?.capabilities.tts,
    ).toBeUndefined();
    // Nor does a plan recommend a capability it no longer offers.
    for (const preset of view.presets) {
      if (!preset.capabilities.tts) expect(preset.recommended).not.toHaveProperty('tts');
    }
    const withProvider = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'voice',
      preset: 'openai-tts',
      apiKey: 'sk-k',
    });
    await expect(
      applyModelSettingsChange(withProvider, { kind: 'slots', set: { tts: 'voice' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENT' });
  });

  it('lists the models of a search provider that searches through a model', () => {
    const search = modelSettingsView(null).presets.find((preset) => preset.id === 'claude');
    expect(search?.capabilities.webSearch?.models.length).toBeGreaterThan(0);
  });

  it('flags a key that no longer opens', () => {
    const view = modelSettingsView({
      config: { providers: { mine: { preset: 'openai' } } },
      revision: 1,
      unreadableSecrets: ['mine'],
    });
    expect(view.providers.find((provider) => provider.id === 'mine')?.key).toEqual({
      set: true,
      unreadable: true,
    });
  });
});

describe('applyModelSettingsChange', () => {
  it('refuses a slot the deployment locks', async () => {
    await expect(
      applyModelSettingsChange(null, { kind: 'slots', set: { llm: 'operator:x' } }),
    ).rejects.toMatchObject({ code: 'SLOT_LOCKED' });
  });

  it('assigns, turns off and clears slots, over deployment providers too', async () => {
    const next = await applyModelSettingsChange(null, {
      kind: 'slots',
      set: { 'course.outline': 'operator:deepseek-v4-flash', image: null },
    });
    expect(next).toEqual({
      slots: { 'course.outline': 'operator:deepseek-v4-flash', image: null },
    });
    expect(await applyModelSettingsChange(next, { kind: 'slots', clear: ['image'] })).toEqual({
      slots: { 'course.outline': 'operator:deepseek-v4-flash' },
    });
  });

  it('refuses an assignment that does not resolve', async () => {
    await expect(
      applyModelSettingsChange(null, { kind: 'slots', set: { tts: 'operator' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENT' });
    await expect(
      applyModelSettingsChange(null, { kind: 'slots', set: { 'course.outline': 'ghost:m' } }),
    ).rejects.toBeInstanceOf(ModelSettingsError);
  });

  it('adds a provider, keeps its key when omitted and removes it when emptied', async () => {
    let config = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'mine',
      preset: 'openai',
      apiKey: 'sk-1',
    });
    config = await applyModelSettingsChange(config, {
      kind: 'provider',
      id: 'mine',
      preset: 'openai',
      models: ['gpt-5.6'],
    });
    expect(config.providers?.mine).toEqual({
      preset: 'openai',
      apiKey: 'sk-1',
      models: ['gpt-5.6'],
    });
    config = await applyModelSettingsChange(config, {
      kind: 'provider',
      id: 'mine',
      preset: 'openai',
      apiKey: '',
    });
    expect(config.providers?.mine).toEqual({ preset: 'openai', models: ['gpt-5.6'] });
  });

  it('keeps workspace providers out of what only the deployment may set', async () => {
    for (const [provider, message] of [
      [{ id: 'operator', preset: 'openai' }, /deployment declares this provider id/],
      [{ id: 'b', preset: 'bedrock' }, /Amazon Bedrock/],
      [
        { id: 'l', preset: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' },
        /Local\/private/,
      ],
      [{ id: 'z', preset: 'openai-compatible' }, /needs a base URL/],
      [{ id: 'c', preset: 'comfyui-image' }, /server's own network/],
      [{ id: 'o', preset: 'ollama' }, /needs a base URL/],
      [
        { id: 'u', preset: 'openai-compatible', baseUrl: 'https://user:pw@1.1.1.1/v1' },
        /not in the base URL/,
      ],
      [{ id: 'a', preset: 'alidocmind', apiKey: 'k' }, /key pair/],
      [{ id: 'bad_id', preset: 'openai', apiKey: 'sk-k' }, /lowercase letters/],
      [{ id: '__proto__', preset: 'openai', apiKey: 'sk-k' }, /lowercase letters/],
    ] as const) {
      await expect(
        applyModelSettingsChange(null, { kind: 'provider', ...provider }),
      ).rejects.toThrow(message);
    }
  });

  it('keeps custom endpoints to chat: media, search and document services use the preset', async () => {
    for (const provider of [
      { id: 's', preset: 'searxng', baseUrl: 'https://searx.example' },
      { id: 't', preset: 'tavily', apiKey: 'k', baseUrl: 'https://search.example' },
    ]) {
      await expect(
        applyModelSettingsChange(null, { kind: 'provider', ...provider }),
      ).rejects.toThrow(/can only be configured by the deployment/);
    }
    const plan = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'mm',
      preset: 'minimax',
      apiKey: 'k',
      baseUrl: 'https://1.1.1.1/v1',
    });
    await expect(
      applyModelSettingsChange(plan, { kind: 'slots', set: { 'course.content': 'mm:MiniMax-M2' } }),
    ).resolves.toBeTruthy();
    await expect(
      applyModelSettingsChange(plan, { kind: 'slots', set: { tts: 'mm:speech-2.8-turbo' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENT' });
  });

  it('refuses providers when the deployment policy does not allow them', async () => {
    deployment({ policy: { allowWorkspaceProviders: false } });
    await expect(
      applyModelSettingsChange(null, { kind: 'provider', id: 'mine', preset: 'openai' }),
    ).rejects.toMatchObject({ code: 'PROVIDERS_NOT_ALLOWED' });
  });

  it('refuses an assignment to a kept workspace provider once the policy forbids them', async () => {
    const kept = {
      providers: { mine: { preset: 'openai', apiKey: 'sk-mine-0000000000' } },
      slots: { 'course.outline': 'mine:gpt-5.6' },
    };
    deployment({ policy: { allowWorkspaceProviders: false } });
    await expect(
      applyModelSettingsChange(kept, { kind: 'slots', set: { llm: 'mine:gpt-5.6' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENT' });
    // A dormant assignment is not checked, even on a provider switched off since.
    vi.stubEnv('TAVILY_ENABLED', 'false');
    vi.resetModules();
    const fresh = await import('@/lib/server/model-config/settings');
    (await import('@/lib/server/model-config/runtime')).setDeploymentConfigForTests({
      layer: { source: 'deployment', config: { policy: { allowWorkspaceProviders: false } } },
      defaults: null,
      notices: [],
    });
    const dormantSearch = {
      providers: { tv: { preset: 'tavily', apiKey: 'tvly-kept-000000' } },
      slots: { webSearch: 'tv' },
    };
    await expect(
      fresh.applyModelSettingsChange(dormantSearch, { kind: 'slots', set: { video: null } }),
    ).resolves.toMatchObject({ slots: { webSearch: 'tv', video: null } });
    // Other edits still save, leaving the dormant assignment as it is.
    await expect(
      applyModelSettingsChange(kept, { kind: 'slots', set: { video: null } }),
    ).resolves.toMatchObject({ slots: { 'course.outline': 'mine:gpt-5.6', video: null } });
  });

  it('drops the assignments of a removed provider', async () => {
    const next = await applyModelSettingsChange(
      {
        providers: { mine: { preset: 'openai', apiKey: 'k' } },
        slots: {
          classroom: 'mine:gpt-5.6',
          'course.outline': { model: 'operator:deepseek-v4-pro', fallback: 'mine:gpt-5.6' },
          image: null,
        },
      },
      { kind: 'remove-provider', id: 'mine' },
    );
    expect(next).toEqual({ slots: { image: null } });
  });
});
