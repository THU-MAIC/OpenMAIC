/**
 * Google Gemini TTS (`google-tts`) on the server-side model configuration: its
 * preset, a workspace adding it, `tts` slot resolution, and the translation of
 * the legacy `TTS_GOOGLE_*` variables.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
}));
vi.mock('@/lib/persistence/owner-merges', () => ({
  isOwnerRetired: async () => false,
  canonicalizeStoredOwner: async (ownerId: string) => ownerId,
}));

const { getProviderPreset, presetModels, registryDefaultBaseUrl, registryRequiresApiKey } =
  await import('@/lib/config/provider-presets');
const runtime = await import('@/lib/server/model-config/runtime');
const { applyModelSettingsChange, modelSettingsView } =
  await import('@/lib/server/model-config/settings');
const { resolveMediaSlot, WorkspaceEndpointError } =
  await import('@/lib/server/model-config/media');
const { translateLegacyConfig } = await import('@/lib/server/model-config/legacy-config');

type Config = import('@/lib/server/model-config/openmaic-yml').ModelConfigFile;
type ServerConfig = import('@/lib/server/provider-config').ServerConfig;

const workspaces = new Map<string, Config>();

function server(tts: ServerConfig['tts'], disabledTts: string[] = []): ServerConfig {
  return {
    providers: {},
    tts,
    asr: {},
    pdf: {},
    image: {},
    video: {},
    webSearch: {},
    disabled: {
      tts: new Set(disabledTts),
      asr: new Set(),
      image: new Set(),
      video: new Set(),
      webSearch: new Set(),
    },
  };
}

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  vi.stubEnv('ALLOW_LOCAL_NETWORKS', '');
  workspaces.clear();
  runtime.setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
  runtime.setWorkspaceLayerLoaderForTests(async (ownerId) => {
    const config = workspaces.get(ownerId);
    return config ? { source: 'workspace', config } : null;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  runtime.setDeploymentConfigForTests();
  runtime.setWorkspaceLayerLoaderForTests();
});

describe('google-tts preset', () => {
  it('is a single-capability TTS preset at the Gemini API endpoint, with a key', () => {
    const preset = getProviderPreset('google-tts');
    expect(preset).toMatchObject({
      id: 'google-tts',
      kind: 'single',
      capabilities: { tts: { registryId: 'google-tts' } },
    });
    expect(preset?.requiresBaseUrl).toBeUndefined();
    expect(registryDefaultBaseUrl('tts', 'google-tts')).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    );
    expect(registryRequiresApiKey('tts', 'google-tts')).toBe(true);
    expect(presetModels(preset!, 'tts').map((model) => model.id)).toEqual([
      'gemini-3.1-flash-tts-preview',
      'gemini-2.5-flash-preview-tts',
      'gemini-2.5-pro-preview-tts',
    ]);
  });

  it('does not take the chat google preset id', () => {
    expect(getProviderPreset('google')?.capabilities.tts).toBeUndefined();
    expect(getProviderPreset('google')?.capabilities.chat?.registryId).toBe('google');
  });
});

describe('a workspace adding Gemini TTS', () => {
  it('is offered, like other preset TTS services with a fixed public endpoint', () => {
    const preset = modelSettingsView(null).presets.find((entry) => entry.id === 'google-tts');
    expect(preset).toMatchObject({ requiresBaseUrl: false, customEndpoint: false });
    expect(preset?.capabilities.tts?.models.map((model) => model.id)).toContain(
      'gemini-3.1-flash-tts-preview',
    );
  });

  it('saves a key and assigns the tts slot; a custom endpoint stays with the deployment', async () => {
    const config = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'gemini-voice',
      preset: 'google-tts',
      apiKey: 'test-gemini-key',
    });
    const assigned = await applyModelSettingsChange(config, {
      kind: 'slots',
      set: { tts: 'gemini-voice:gemini-2.5-flash-preview-tts' },
    });
    expect(assigned).toEqual({
      providers: { 'gemini-voice': { preset: 'google-tts', apiKey: 'test-gemini-key' } },
      slots: { tts: 'gemini-voice:gemini-2.5-flash-preview-tts' },
    });
    await expect(
      applyModelSettingsChange(null, {
        kind: 'provider',
        id: 'gemini-voice',
        preset: 'google-tts',
        apiKey: 'k',
        baseUrl: 'https://gemini-proxy.example/v1beta',
      }),
    ).rejects.toThrow(/can only be configured by the deployment/);
  });
});

describe('tts slot resolution', () => {
  it("resolves a workspace's Gemini TTS provider at the preset's own endpoint", async () => {
    workspaces.set('user:alice', {
      providers: { gv: { preset: 'google-tts', apiKey: 'test-gemini-key' } },
      slots: { tts: 'gv:gemini-3.1-flash-tts-preview' },
    });
    const connection = await resolveMediaSlot('tts', { workspaceId: 'user:alice' });
    expect(connection).toMatchObject({
      providerId: 'google-tts',
      modelId: 'gemini-3.1-flash-tts-preview',
      apiKey: 'test-gemini-key',
      managed: false,
      userEndpoint: false,
      origin: 'configuration',
    });
    expect(connection.baseUrl).toBeUndefined();
  });

  it('refuses a custom endpoint stored on a workspace Gemini TTS provider', async () => {
    workspaces.set('user:alice', {
      providers: {
        gv: { preset: 'google-tts', apiKey: 'k', baseUrl: 'https://gemini-proxy.example' },
      },
      slots: { tts: 'gv' },
    });
    await expect(resolveMediaSlot('tts', { workspaceId: 'user:alice' })).rejects.toBeInstanceOf(
      WorkspaceEndpointError,
    );
  });

  it('keeps a deployment Gemini TTS provider with its own endpoint', async () => {
    runtime.setDeploymentConfigForTests({
      layer: {
        source: 'deployment',
        config: {
          providers: {
            gemini: {
              preset: 'google-tts',
              apiKey: 'operator-key',
              baseUrl: 'https://gemini-proxy.example/v1beta',
            },
          },
          slots: { tts: 'gemini' },
        },
      },
      legacy: false,
      notices: [],
    });
    const connection = await resolveMediaSlot('tts', { workspaceId: null });
    expect(connection).toMatchObject({
      providerId: 'google-tts',
      apiKey: 'operator-key',
      baseUrl: 'https://gemini-proxy.example/v1beta',
      managed: true,
    });
  });
});

describe('legacy TTS_GOOGLE_* configuration', () => {
  it('becomes a google-tts deployment provider and the default tts assignment', () => {
    const { config, notices } = translateLegacyConfig(
      server({
        'google-tts': {
          apiKey: 'env-gemini-key',
          baseUrl: 'https://gemini-proxy.example/v1beta',
          models: ['gemini-2.5-pro-preview-tts'],
        },
      }),
    );
    expect(notices).toEqual([]);
    expect(config.providers).toEqual({
      'google-tts': {
        preset: 'google-tts',
        apiKey: 'env-gemini-key',
        baseUrl: 'https://gemini-proxy.example/v1beta',
        models: ['gemini-2.5-pro-preview-tts'],
      },
    });
    expect(config.slots).toEqual({ tts: 'google-tts:gemini-2.5-pro-preview-tts' });
  });

  it('leaves out a Gemini TTS provider the operator switched off', () => {
    const { config, notices } = translateLegacyConfig(
      server({ 'google-tts': { apiKey: 'env-gemini-key' } }, ['google-tts']),
    );
    expect(config.providers).toBeUndefined();
    expect(notices).toEqual([
      'tts.google-tts is switched off by the operator; openmaic.yml has no such switch, so leave it out or set its slot to null',
    ]);
  });

  it('reads TTS_GOOGLE_API_KEY and TTS_GOOGLE_BASE_URL into the tts section', async () => {
    vi.resetModules();
    vi.stubEnv('TTS_GOOGLE_API_KEY', 'env-gemini-key');
    vi.stubEnv('TTS_GOOGLE_BASE_URL', 'https://gemini-proxy.example/v1beta');
    const { getServerProviderConfig } = await import('@/lib/server/provider-config');
    expect(getServerProviderConfig().tts['google-tts']).toMatchObject({
      apiKey: 'env-gemini-key',
      baseUrl: 'https://gemini-proxy.example/v1beta',
    });
  });
});
