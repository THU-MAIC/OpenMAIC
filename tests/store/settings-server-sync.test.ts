/**
 * Tests for fetchServerProviders() — verifying that the settings store
 * correctly reflects server-side provider availability changes.
 *
 * Core invariant: after server sync, the set of models/providers a user
 * can select in the UI must match what the server currently supports.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { isProviderUsable } from '@/lib/store/settings-validation';

// ---------------------------------------------------------------------------
// Mocks — must be defined before importing the store
// ---------------------------------------------------------------------------

// Minimal built-in provider registry used by the store
vi.mock('@/lib/ai/providers', () => ({
  PROVIDERS: {
    openai: {
      id: 'openai',
      name: 'OpenAI',
      type: 'openai',
      defaultBaseUrl: 'https://api.openai.com/v1',
      requiresApiKey: true,
      icon: '/logos/openai.svg',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
        { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
      ],
    },
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic',
      type: 'anthropic',
      defaultBaseUrl: 'https://api.anthropic.com',
      requiresApiKey: true,
      icon: '/logos/anthropic.svg',
      models: [
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
      ],
    },
    deepseek: {
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'openai',
      defaultBaseUrl: 'https://api.deepseek.com/v1',
      requiresApiKey: true,
      icon: '/logos/deepseek.svg',
      models: [
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      ],
    },
  },
}));

vi.mock('@/lib/audio/constants', () => ({
  TTS_PROVIDERS: {
    'openai-tts': {
      id: 'openai-tts',
      name: 'OpenAI TTS',
      requiresApiKey: true,
      defaultModelId: 'gpt-4o-mini-tts',
      models: [{ id: 'gpt-4o-mini-tts', name: 'GPT-4o Mini TTS' }],
      voices: [{ id: 'alloy', name: 'Alloy', language: 'en', gender: 'neutral' }],
      supportedFormats: ['mp3'],
    },
    'azure-tts': {
      id: 'azure-tts',
      name: 'Azure TTS',
      requiresApiKey: true,
      defaultModelId: '',
      models: [],
      voices: [{ id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao', language: 'zh-CN' }],
      supportedFormats: ['mp3'],
    },
    'browser-native-tts': {
      id: 'browser-native-tts',
      name: 'Browser Native TTS',
      requiresApiKey: false,
      defaultModelId: '',
      models: [],
      voices: [{ id: 'default', name: 'Default', language: 'en', gender: 'neutral' }],
      supportedFormats: ['browser'],
      speedRange: { min: 0.1, max: 10, default: 1 },
    },
  },
  ASR_PROVIDERS: {
    'openai-whisper': {
      id: 'openai-whisper',
      name: 'OpenAI Whisper',
      requiresApiKey: true,
      defaultModelId: 'gpt-4o-mini-transcribe',
      models: [{ id: 'gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe' }],
      supportedLanguages: ['auto', 'zh'],
      supportedFormats: ['webm'],
    },
    'browser-native': {
      id: 'browser-native',
      name: 'Browser Native ASR',
      requiresApiKey: false,
      defaultModelId: '',
      models: [],
      supportedLanguages: ['zh'],
      supportedFormats: ['browser'],
    },
  },
  DEFAULT_TTS_VOICES: {
    'openai-tts': 'alloy',
    'browser-native-tts': 'default',
  },
}));

vi.mock('@/lib/audio/types', () => ({
  isCustomTTSProvider: (id: string) => id.startsWith('custom-tts-'),
  isCustomASRProvider: (id: string) => id.startsWith('custom-asr-'),
}));

vi.mock('@/lib/pdf/constants', () => ({
  PDF_PROVIDERS: {
    unpdf: { id: 'unpdf', requiresApiKey: false },
    mineru: { id: 'mineru', requiresApiKey: false },
  },
}));

vi.mock('@/lib/media/image-providers', () => ({
  IMAGE_PROVIDERS: {
    seedream: {
      id: 'seedream',
      requiresApiKey: true,
      models: [{ id: 'doubao-seedream-5-0-260128', name: 'Seedream 5.0' }],
    },
    'qwen-image': {
      id: 'qwen-image',
      requiresApiKey: true,
      models: [{ id: 'qwen-image-max', name: 'Qwen Image Max' }],
    },
  },
}));

vi.mock('@/lib/media/video-providers', () => ({
  VIDEO_PROVIDERS: {
    seedance: {
      id: 'seedance',
      requiresApiKey: true,
      models: [{ id: 'doubao-seedance-2-0-260128', name: 'Seedance 2.0' }],
    },
    kling: {
      id: 'kling',
      requiresApiKey: true,
      models: [{ id: 'kling-v2-6', name: 'Kling V2' }],
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Stub global fetch
const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

// Stub localStorage
const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
};
vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Full server response shape */
interface MockServerResponse {
  providers?: Record<string, { models?: string[]; baseUrl?: string }>;
  tts?: Record<string, { baseUrl?: string; disabled?: boolean }>;
  asr?: Record<string, { baseUrl?: string }>;
  pdf?: Record<string, { baseUrl?: string }>;
  image?: Record<string, { baseUrl?: string }>;
  video?: Record<string, { baseUrl?: string }>;
  webSearch?: Record<string, { baseUrl?: string }>;
}

function mockServerResponse(overrides: MockServerResponse = {}) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      providers: {},
      tts: {},
      asr: {},
      pdf: {},
      image: {},
      video: {},
      webSearch: {},
      ...overrides,
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('settings rehydrate — built-in provider models', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    mockFetch.mockReset();
  });

  async function getStore() {
    const { useSettingsStore } = await import('@/lib/store/settings');
    return useSettingsStore;
  }

  it('reorders persisted built-in models to registry order while preserving custom models', async () => {
    storage.set(
      'settings-storage',
      JSON.stringify({
        state: {
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          providersConfig: {
            openai: {
              apiKey: '',
              baseUrl: '',
              models: [
                { id: 'custom-earlier', name: 'Custom Earlier' },
                { id: 'gpt-4-turbo', name: 'Old GPT-4 Turbo' },
                { id: 'gpt-4o-mini', name: 'Old GPT-4o Mini' },
                { id: 'custom-later', name: 'Custom Later' },
                { id: 'gpt-4o', name: 'Old GPT-4o' },
              ],
              name: 'OpenAI',
              type: 'openai',
              defaultBaseUrl: 'https://api.openai.com/v1',
              icon: '/logos/openai.svg',
              requiresApiKey: true,
              isBuiltIn: true,
            },
          },
        },
        version: 2,
      }),
    );

    const store = await getStore();
    const models = store.getState().providersConfig.openai.models;

    expect(models.map((m) => m.id)).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'custom-earlier',
      'custom-later',
    ]);
    expect(models[0].name).toBe('GPT-4o');
    expect(models[3].name).toBe('Custom Earlier');
  });

  it('strips a legacy serverBaseUrl from persisted provider configs on rehydrate (#620)', async () => {
    storage.set(
      'settings-storage',
      JSON.stringify({
        state: {
          providerId: 'openai',
          modelId: 'gpt-4o',
          providersConfig: {
            openai: {
              apiKey: '',
              baseUrl: '',
              models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
              name: 'OpenAI',
              type: 'openai',
              defaultBaseUrl: 'https://api.openai.com/v1',
              requiresApiKey: true,
              isBuiltIn: true,
              isServerConfigured: true,
              serverBaseUrl: 'https://internal-gateway.local/v1',
            },
          },
          webSearchProvidersConfig: {
            bocha: {
              apiKey: '',
              baseUrl: '',
              enabled: true,
              requiresApiKey: true,
              isServerConfigured: true,
              serverBaseUrl: 'https://api.bocha.cn',
            },
          },
        },
        version: 2,
      }),
    );

    const store = await getStore();
    const openai = store.getState().providersConfig.openai as unknown as Record<string, unknown>;
    const bocha = store.getState().webSearchProvidersConfig.bocha as unknown as Record<
      string,
      unknown
    >;

    // The removed field must not linger in persisted client state...
    expect('serverBaseUrl' in openai).toBe(false);
    expect('serverBaseUrl' in bocha).toBe(false);
    // ...while the managed flag itself is preserved.
    expect(openai.isServerConfigured).toBe(true);
  });

  it('removes the retired insert-toolbar collapse preference on rehydrate', async () => {
    storage.set(
      'settings-storage',
      JSON.stringify({
        state: { editInsertToolbarCollapsed: true },
        version: 4,
      }),
    );

    const store = await getStore();
    expect('editInsertToolbarCollapsed' in store.getState()).toBe(false);

    store.getState().setSidebarCollapsed(false);
    const persisted = JSON.parse(storage.get('settings-storage')!).state;
    expect('editInsertToolbarCollapsed' in persisted).toBe(false);
  });
});

describe('fetchServerProviders — provider availability sync', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    mockFetch.mockReset();
  });

  async function getStore() {
    const { useSettingsStore } = await import('@/lib/store/settings');
    return useSettingsStore;
  }

  // ---- Server model list filtering ----

  it('filters models to only those the server allows', async () => {
    const store = await getStore();
    mockServerResponse({
      providers: {
        openai: { models: ['gpt-4o'] },
      },
    });

    await store.getState().fetchServerProviders();

    const config = store.getState().providersConfig.openai;
    const modelIds = config.models.map((m) => m.id);
    expect(modelIds).toEqual(['gpt-4o']);
    expect(modelIds).not.toContain('gpt-4o-mini');
    expect(modelIds).not.toContain('gpt-4-turbo');
  });

  it('preserves custom server model IDs in server order', async () => {
    const store = await getStore();
    mockServerResponse({
      providers: {
        openai: { models: ['gpt-5.5', 'gpt-4o'] },
      },
    });

    await store.getState().fetchServerProviders();

    const models = store.getState().providersConfig.openai.models;
    expect(models.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-4o']);
    expect(models[0].name).toBe('gpt-5.5');
    expect(models[1].name).toBe('GPT-4o');
  });

  it('enriches a managed GPT-5.6 Sol alias with canonical catalog metadata', async () => {
    const store = await getStore();
    store.setState({
      providersConfig: {
        ...store.getState().providersConfig,
        openai: {
          ...store.getState().providersConfig.openai,
          models: [
            {
              id: 'gpt-5.6',
              name: 'GPT-5.6 Sol',
              contextWindow: 1050000,
              outputWindow: 128000,
              capabilities: {
                vision: true,
                thinking: {
                  requestAdapter: 'openai',
                  defaultEffort: 'medium',
                },
              },
            },
          ],
        },
      },
    });
    mockServerResponse({
      providers: {
        openai: { models: ['gpt-5.6-sol'] },
      },
    });

    await store.getState().fetchServerProviders();

    const model = store.getState().providersConfig.openai.models[0];
    expect(model).toMatchObject({
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      contextWindow: 1050000,
      outputWindow: 128000,
      capabilities: {
        vision: true,
        thinking: {
          requestAdapter: 'openai',
          defaultEffort: 'medium',
        },
      },
    });
  });

  it('switches a canonical selection to the alias when the managed allowlist only permits it', async () => {
    const store = await getStore();
    store.setState({ providerId: 'openai', modelId: 'gpt-5.6' });
    mockServerResponse({
      providers: {
        openai: { models: ['gpt-5.6-sol'] },
      },
    });

    await store.getState().fetchServerProviders();

    expect(store.getState().modelId).toBe('gpt-5.6-sol');
  });

  it('keeps all models when server provides no model restriction', async () => {
    const store = await getStore();
    mockServerResponse({
      providers: {
        openai: {}, // no models field = no restriction
      },
    });

    await store.getState().fetchServerProviders();

    const modelIds = store.getState().providersConfig.openai.models.map((m) => m.id);
    expect(modelIds).toContain('gpt-4o');
    expect(modelIds).toContain('gpt-4o-mini');
    expect(modelIds).toContain('gpt-4-turbo');
  });

  it('removes a model when server drops it from the allowed list', async () => {
    const store = await getStore();

    // Round 1: server allows two models
    mockServerResponse({
      providers: {
        openai: { models: ['gpt-4o', 'gpt-4o-mini'] },
      },
    });
    await store.getState().fetchServerProviders();
    expect(store.getState().providersConfig.openai.models.map((m) => m.id)).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ]);

    // Round 2: server removes gpt-4o-mini
    mockServerResponse({
      providers: {
        openai: { models: ['gpt-4o'] },
      },
    });
    await store.getState().fetchServerProviders();
    const modelIds = store.getState().providersConfig.openai.models.map((m) => m.id);
    expect(modelIds).toEqual(['gpt-4o']);
    expect(modelIds).not.toContain('gpt-4o-mini');
  });

  // ---- Provider availability flags ----

  it('marks provider as server-configured when present in response', async () => {
    const store = await getStore();
    mockServerResponse({
      providers: {
        openai: { models: ['gpt-4o'] },
      },
    });

    await store.getState().fetchServerProviders();

    expect(store.getState().providersConfig.openai.isServerConfigured).toBe(true);
  });

  it('resets isServerConfigured when provider disappears from response', async () => {
    const store = await getStore();

    // Round 1: openai is server-configured
    mockServerResponse({ providers: { openai: { models: ['gpt-4o'] } } });
    await store.getState().fetchServerProviders();
    expect(store.getState().providersConfig.openai.isServerConfigured).toBe(true);

    // Round 2: openai is no longer in server response
    mockServerResponse({});
    await store.getState().fetchServerProviders();
    expect(store.getState().providersConfig.openai.isServerConfigured).toBe(false);
  });

  it('provider without client key and not server-configured has no usable path', async () => {
    const store = await getStore();
    mockServerResponse({}); // no server providers

    await store.getState().fetchServerProviders();

    const config = store.getState().providersConfig.openai;
    // No client key, not server-configured → provider should not be "ready"
    expect(config.apiKey).toBe('');
    expect(config.isServerConfigured).toBe(false);
    // This is the condition model-selector uses to decide if a provider is usable:
    const isUsable = isProviderUsable(config);
    expect(isUsable).toBe(false);
  });

  // ---- Multiple providers ----

  it('handles mixed provider state: one configured, one not', async () => {
    const store = await getStore();
    mockServerResponse({
      providers: {
        openai: { models: ['gpt-4o'] },
        // anthropic not in response
      },
    });

    await store.getState().fetchServerProviders();

    expect(store.getState().providersConfig.openai.isServerConfigured).toBe(true);
    expect(store.getState().providersConfig.anthropic.isServerConfigured).toBe(false);
  });

  // ---- serverModels metadata ----

  it('stores serverModels metadata for downstream filtering', async () => {
    const store = await getStore();
    mockServerResponse({
      providers: {
        openai: { models: ['gpt-4o', 'gpt-4o-mini'] },
      },
    });

    await store.getState().fetchServerProviders();

    expect(store.getState().providersConfig.openai.serverModels).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('clears serverModels when provider removed from server', async () => {
    const store = await getStore();

    mockServerResponse({ providers: { openai: { models: ['gpt-4o'] } } });
    await store.getState().fetchServerProviders();
    expect(store.getState().providersConfig.openai.serverModels).toEqual(['gpt-4o']);

    mockServerResponse({});
    await store.getState().fetchServerProviders();
    expect(store.getState().providersConfig.openai.serverModels).toBeUndefined();
  });

  // ---- Stale selection consistency ----

  // BUG: fetchServerProviders() updates providersConfig.models but never
  // validates the current modelId/providerId selection against the new list.
  // These tests document the desired fix — remove .fails() once implemented.

  it('clears modelId when server removes the selected model', async () => {
    const store = await getStore();

    // User selects gpt-4o-mini while it's available
    store.getState().setModel('openai', 'gpt-4o-mini');
    expect(store.getState().modelId).toBe('gpt-4o-mini');

    // Server drops gpt-4o-mini
    mockServerResponse({ providers: { openai: { models: ['gpt-4o'] } } });
    await store.getState().fetchServerProviders();

    // modelId should be cleared, not silently kept as a stale value
    expect(store.getState().modelId).toBe('gpt-4o');
  });

  it('clears providerId when entire provider loses server config and has no client key', async () => {
    const store = await getStore();

    // User on a server-only provider (no client key)
    store.getState().setModel('openai', 'gpt-4o');
    mockServerResponse({ providers: { openai: { models: ['gpt-4o'] } } });
    await store.getState().fetchServerProviders();
    expect(store.getState().providersConfig.openai.isServerConfigured).toBe(true);

    // Server removes openai entirely — no client key either
    mockServerResponse({});
    await store.getState().fetchServerProviders();

    // Provider is unusable → selection should be cleared
    expect(store.getState().providerId).toBe('');
    expect(store.getState().modelId).toBe('');
  });

  it('clears modelId when server narrows model list and selected model is excluded', async () => {
    const store = await getStore();

    // Round 1: user picks gpt-4-turbo
    mockServerResponse({
      providers: { openai: { models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'] } },
    });
    await store.getState().fetchServerProviders();
    store.getState().setModel('openai', 'gpt-4-turbo');

    // Round 2: server narrows to gpt-4o only
    mockServerResponse({ providers: { openai: { models: ['gpt-4o'] } } });
    await store.getState().fetchServerProviders();

    // Selection should be cleared, not left pointing to unavailable model
    expect(store.getState().modelId).toBe('gpt-4o');
  });

  it('keeps modelId when selected model is still available after server sync', async () => {
    const store = await getStore();

    store.getState().setModel('openai', 'gpt-4o');
    mockServerResponse({ providers: { openai: { models: ['gpt-4o', 'gpt-4o-mini'] } } });
    await store.getState().fetchServerProviders();

    // gpt-4o is still available — selection should be preserved
    expect(store.getState().providerId).toBe('openai');
    expect(store.getState().modelId).toBe('gpt-4o');
  });

  it('selects the server LLM model when provider fallback replaces the default provider', async () => {
    const store = await getStore();

    expect(store.getState().providerId).toBe('openai');
    expect(store.getState().modelId).toBe('');

    mockServerResponse({
      providers: {
        deepseek: { models: ['deepseek-chat'] },
      },
    });
    await store.getState().fetchServerProviders();

    expect(store.getState().providerId).toBe('deepseek');
    expect(store.getState().modelId).toBe('deepseek-chat');
  });

  // ---- Error handling ----

  it('does not modify state when fetch returns non-ok response', async () => {
    const store = await getStore();

    // First, set up a known state
    mockServerResponse({ providers: { openai: { models: ['gpt-4o'] } } });
    await store.getState().fetchServerProviders();
    expect(store.getState().providersConfig.openai.isServerConfigured).toBe(true);

    // Now fetch returns an error
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await store.getState().fetchServerProviders();

    // State should be unchanged — the failed fetch should not wipe existing config
    expect(store.getState().providersConfig.openai.isServerConfigured).toBe(true);
  });

  it('does not throw when fetch rejects (network error)', async () => {
    const store = await getStore();

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    // Should not throw — server providers are optional
    await expect(store.getState().fetchServerProviders()).resolves.not.toThrow();
  });
});

describe('fetchServerProviders — TTS stale selection', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    mockFetch.mockReset();
  });

  async function getStore() {
    const { useSettingsStore } = await import('@/lib/store/settings');
    return useSettingsStore;
  }

  it('falls back to browser-native-tts when selected TTS provider loses server config', async () => {
    const store = await getStore();

    mockServerResponse({ tts: { 'openai-tts': {} } });
    await store.getState().fetchServerProviders();
    store.getState().setTTSProvider('openai-tts');
    expect(store.getState().ttsProviderId).toBe('openai-tts');

    mockServerResponse({});
    await store.getState().fetchServerProviders();

    expect(store.getState().ttsProviderId).toBe('browser-native-tts');
  });

  it('falls back to remaining server TTS provider when selected one is removed', async () => {
    const store = await getStore();

    mockServerResponse({ tts: { 'openai-tts': {}, 'azure-tts': {} } });
    await store.getState().fetchServerProviders();
    store.getState().setTTSProvider('openai-tts');

    mockServerResponse({ tts: { 'azure-tts': {} } });
    await store.getState().fetchServerProviders();

    expect(store.getState().ttsProviderId).toBe('azure-tts');
  });

  it('keeps TTS provider when it is still server-configured', async () => {
    const store = await getStore();

    mockServerResponse({ tts: { 'openai-tts': {} } });
    await store.getState().fetchServerProviders();
    store.getState().setTTSProvider('openai-tts');

    mockServerResponse({ tts: { 'openai-tts': {} } });
    await store.getState().fetchServerProviders();

    expect(store.getState().ttsProviderId).toBe('openai-tts');
  });
});

describe('fetchServerProviders — ASR stale selection', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    mockFetch.mockReset();
  });

  async function getStore() {
    const { useSettingsStore } = await import('@/lib/store/settings');
    return useSettingsStore;
  }

  it('falls back to browser-native when selected ASR provider loses server config', async () => {
    const store = await getStore();

    mockServerResponse({ asr: { 'openai-whisper': {} } });
    await store.getState().fetchServerProviders();
    store.getState().setASRProvider('openai-whisper');
    expect(store.getState().asrProviderId).toBe('openai-whisper');

    mockServerResponse({});
    await store.getState().fetchServerProviders();

    expect(store.getState().asrProviderId).toBe('browser-native');
  });

  it('keeps ASR provider when it is still server-configured', async () => {
    const store = await getStore();

    mockServerResponse({ asr: { 'openai-whisper': {} } });
    await store.getState().fetchServerProviders();
    store.getState().setASRProvider('openai-whisper');

    mockServerResponse({ asr: { 'openai-whisper': {} } });
    await store.getState().fetchServerProviders();

    expect(store.getState().asrProviderId).toBe('openai-whisper');
  });
});

describe('fetchServerProviders — Web Search provider sync', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    mockFetch.mockReset();
  });

  async function getStore() {
    const { useSettingsStore } = await import('@/lib/store/settings');
    return useSettingsStore;
  }

  it('marks Bocha as server-configured without storing a server base URL', async () => {
    const store = await getStore();
    mockServerResponse({
      webSearch: {
        bocha: {},
      },
    });

    await store.getState().fetchServerProviders();

    const bocha = store.getState().webSearchProvidersConfig.bocha;
    expect(bocha.isServerConfigured).toBe(true);
    // The server base URL is never exposed to / stored on the client.
    expect((bocha as Record<string, unknown>).serverBaseUrl).toBeUndefined();
  });

  it('falls back to Bocha when selected Tavily loses server config and has no client key', async () => {
    const store = await getStore();

    mockServerResponse({
      webSearch: {
        tavily: { baseUrl: 'https://api.tavily.com' },
        bocha: { baseUrl: 'https://api.bocha.cn' },
      },
    });
    await store.getState().fetchServerProviders();
    store.getState().setWebSearchProvider('tavily');

    mockServerResponse({
      webSearch: {
        bocha: { baseUrl: 'https://api.bocha.cn' },
      },
    });
    await store.getState().fetchServerProviders();

    expect(store.getState().webSearchProviderId).toBe('bocha');
  });

  it('keeps Bocha selected when it is still server-configured', async () => {
    const store = await getStore();

    mockServerResponse({
      webSearch: {
        bocha: { baseUrl: 'https://api.bocha.cn' },
      },
    });
    await store.getState().fetchServerProviders();
    store.getState().setWebSearchProvider('bocha');

    mockServerResponse({
      webSearch: {
        bocha: { baseUrl: 'https://api.bocha.cn' },
      },
    });
    await store.getState().fetchServerProviders();

    expect(store.getState().webSearchProviderId).toBe('bocha');
  });

  it('stores Baidu sub-source toggles and prevents disabling every source', async () => {
    const store = await getStore();

    expect(store.getState().baiduSubSources).toEqual({
      webSearch: true,
      baike: true,
      scholar: true,
    });

    store.getState().setBaiduSubSources({ webSearch: false, scholar: false });
    expect(store.getState().baiduSubSources).toEqual({
      webSearch: false,
      baike: true,
      scholar: false,
    });

    store.getState().setBaiduSubSources({ baike: false });
    expect(store.getState().baiduSubSources).toEqual({
      webSearch: false,
      baike: true,
      scholar: false,
    });
  });
});

describe('fetchServerProviders — PDF stale selection', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    mockFetch.mockReset();
  });

  async function getStore() {
    const { useSettingsStore } = await import('@/lib/store/settings');
    return useSettingsStore;
  }

  it('falls back to unpdf when mineru loses server config', async () => {
    const store = await getStore();

    mockServerResponse({ pdf: { mineru: {} } });
    await store.getState().fetchServerProviders();
    store.getState().setPDFProvider('mineru');

    mockServerResponse({});
    await store.getState().fetchServerProviders();

    expect(store.getState().pdfProviderId).toBe('unpdf');
  });
});

describe('fetchServerProviders — Image stale selection', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    mockFetch.mockReset();
  });

  async function getStore() {
    const { useSettingsStore } = await import('@/lib/store/settings');
    return useSettingsStore;
  }

  it('clears imageProviderId and imageModelId when provider loses server config', async () => {
    const store = await getStore();

    mockServerResponse({ image: { seedream: {} } });
    await store.getState().fetchServerProviders();
    store.getState().setImageProvider('seedream');
    store.getState().setImageModelId('doubao-seedream-5-0-260128');

    mockServerResponse({});
    await store.getState().fetchServerProviders();

    expect(store.getState().imageProviderId).toBe('');
    expect(store.getState().imageModelId).toBe('');
  });

  it('disables imageGenerationEnabled when no image provider is usable', async () => {
    const store = await getStore();

    // Server configures seedream, user enables image generation
    mockServerResponse({ image: { seedream: {} } });
    await store.getState().fetchServerProviders();
    store.getState().setImageProvider('seedream');
    store.getState().setImageGenerationEnabled(true);
    expect(store.getState().imageGenerationEnabled).toBe(true);

    // Server removes all image providers
    mockServerResponse({});
    await store.getState().fetchServerProviders();

    expect(store.getState().imageGenerationEnabled).toBe(false);
  });

  it('prevents enabling image generation when no image provider is usable', async () => {
    const store = await getStore();

    // No server image providers
    mockServerResponse({});
    await store.getState().fetchServerProviders();

    // User tries to enable image generation
    store.getState().setImageGenerationEnabled(true);
    expect(store.getState().imageGenerationEnabled).toBe(false);
  });

  it('preserves user-disabled image generation across server syncs', async () => {
    const store = await getStore();

    // Server has seedream, auto-enabled on first sync
    mockServerResponse({ image: { seedream: {} } });
    await store.getState().fetchServerProviders();
    expect(store.getState().imageGenerationEnabled).toBe(true);

    // User intentionally disables
    store.getState().setImageGenerationEnabled(false);
    expect(store.getState().imageGenerationEnabled).toBe(false);

    // Next server sync — same config, should NOT re-enable
    mockServerResponse({ image: { seedream: {} } });
    await store.getState().fetchServerProviders();
    expect(store.getState().imageGenerationEnabled).toBe(false);
  });

  it('falls back to another server-configured image provider', async () => {
    const store = await getStore();

    mockServerResponse({ image: { seedream: {}, 'qwen-image': {} } });
    await store.getState().fetchServerProviders();
    store.getState().setImageProvider('seedream');
    store.getState().setImageModelId('doubao-seedream-5-0-260128');

    mockServerResponse({ image: { 'qwen-image': {} } });
    await store.getState().fetchServerProviders();

    expect(store.getState().imageProviderId).toBe('qwen-image');
    expect(store.getState().imageModelId).toBe('qwen-image-max');
  });

  it('auto-selects provider and model when server adds image provider after empty state', async () => {
    const store = await getStore();

    // Start with no image providers — selection is empty, generation disabled
    mockServerResponse({});
    await store.getState().fetchServerProviders();
    expect(store.getState().imageProviderId).toBe('');
    expect(store.getState().imageModelId).toBe('');
    expect(store.getState().imageGenerationEnabled).toBe(false);

    // Server adds seedream
    mockServerResponse({ image: { seedream: {} } });
    await store.getState().fetchServerProviders();

    expect(store.getState().imageProviderId).toBe('seedream');
    expect(store.getState().imageModelId).toBe('doubao-seedream-5-0-260128');
    // Provider recovered but generation stays off — user enables manually
    expect(store.getState().imageGenerationEnabled).toBe(false);
  });

  it('auto-enables image generation on first load when server has image provider', async () => {
    const store = await getStore();

    // First ever fetchServerProviders — server has seedream
    // Default state: imageProviderId='seedream', imageGenerationEnabled=false, autoConfigApplied=false
    mockServerResponse({ image: { seedream: {} } });
    await store.getState().fetchServerProviders();

    expect(store.getState().imageGenerationEnabled).toBe(true);
    expect(store.getState().imageProviderId).toBe('seedream');
    expect(store.getState().imageModelId).toBe('doubao-seedream-5-0-260128');
  });

  it('does not force-enable when provider is already set but generation was disabled', async () => {
    const store = await getStore();

    // autoConfigApplied=true, provider already set, generation off (user choice)
    mockServerResponse({});
    await store.getState().fetchServerProviders(); // sets autoConfigApplied=true

    store.setState({
      imageProviderId: 'seedream',
      imageModelId: '',
      imageGenerationEnabled: false,
    });

    // Server has seedream — should NOT force-enable (provider was already set)
    mockServerResponse({ image: { seedream: {} } });
    await store.getState().fetchServerProviders();

    expect(store.getState().imageGenerationEnabled).toBe(false);
    // But model should be auto-filled
    expect(store.getState().imageModelId).toBe('doubao-seedream-5-0-260128');
  });
});

describe('fetchServerProviders — Video stale selection', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    mockFetch.mockReset();
  });

  async function getStore() {
    const { useSettingsStore } = await import('@/lib/store/settings');
    return useSettingsStore;
  }

  it('clears videoProviderId and videoModelId when provider loses server config', async () => {
    const store = await getStore();

    mockServerResponse({ video: { seedance: {} } });
    await store.getState().fetchServerProviders();
    store.getState().setVideoProvider('seedance');
    store.getState().setVideoModelId('doubao-seedance-2-0-260128');

    mockServerResponse({});
    await store.getState().fetchServerProviders();

    expect(store.getState().videoProviderId).toBe('');
    expect(store.getState().videoModelId).toBe('');
  });

  it('disables videoGenerationEnabled when no video provider is usable', async () => {
    const store = await getStore();

    mockServerResponse({ video: { seedance: {} } });
    await store.getState().fetchServerProviders();
    store.getState().setVideoProvider('seedance');
    store.getState().setVideoGenerationEnabled(true);
    expect(store.getState().videoGenerationEnabled).toBe(true);

    mockServerResponse({});
    await store.getState().fetchServerProviders();

    expect(store.getState().videoGenerationEnabled).toBe(false);
  });

  it('prevents enabling video generation when no video provider is usable', async () => {
    const store = await getStore();

    mockServerResponse({});
    await store.getState().fetchServerProviders();

    store.getState().setVideoGenerationEnabled(true);
    expect(store.getState().videoGenerationEnabled).toBe(false);
  });

  it('falls back to another server-configured video provider', async () => {
    const store = await getStore();

    mockServerResponse({ video: { seedance: {}, kling: {} } });
    await store.getState().fetchServerProviders();
    store.getState().setVideoProvider('seedance');
    store.getState().setVideoModelId('doubao-seedance-2-0-260128');

    mockServerResponse({ video: { kling: {} } });
    await store.getState().fetchServerProviders();

    expect(store.getState().videoProviderId).toBe('kling');
    expect(store.getState().videoModelId).toBe('kling-v2-6');
  });

  it('auto-selects provider and model when server adds video provider after empty state', async () => {
    const store = await getStore();

    // Start with no video providers — generation disabled
    mockServerResponse({});
    await store.getState().fetchServerProviders();
    expect(store.getState().videoProviderId).toBe('');
    expect(store.getState().videoModelId).toBe('');
    expect(store.getState().videoGenerationEnabled).toBe(false);

    // Server adds seedance
    mockServerResponse({ video: { seedance: {} } });
    await store.getState().fetchServerProviders();

    expect(store.getState().videoProviderId).toBe('seedance');
    expect(store.getState().videoModelId).toBe('doubao-seedance-2-0-260128');
    // Provider recovered but generation stays off — user enables manually
    expect(store.getState().videoGenerationEnabled).toBe(false);
  });
});

describe('fetchServerProviders — LLM cross-provider fallback', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    mockFetch.mockReset();
  });

  async function getStore() {
    const { useSettingsStore } = await import('@/lib/store/settings');
    return useSettingsStore;
  }

  it('falls back to another server-configured LLM provider when current becomes unusable', async () => {
    const store = await getStore();

    mockServerResponse({
      providers: {
        openai: { models: ['gpt-4o'] },
        anthropic: { models: ['claude-sonnet-4-6'] },
      },
    });
    await store.getState().fetchServerProviders();
    store.getState().setModel('openai', 'gpt-4o');

    mockServerResponse({
      providers: {
        anthropic: { models: ['claude-sonnet-4-6'] },
      },
    });
    await store.getState().fetchServerProviders();

    expect(store.getState().providerId).toBe('anthropic');
    expect(store.getState().modelId).toBe('claude-sonnet-4-6');
  });
});

describe('usable provider ⇒ concrete model invariant (#580)', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    mockFetch.mockReset();
  });

  async function getStore() {
    const { useSettingsStore } = await import('@/lib/store/settings');
    return useSettingsStore;
  }

  it('server sync: LLM provider usable via client API key resolves a concrete model (not empty)', async () => {
    const store = await getStore();

    // First sync establishes autoConfigApplied; server offers nothing.
    mockServerResponse({});
    await store.getState().fetchServerProviders();

    // Illegal state #580 targets: a usable provider (client key) with empty model.
    store.setState({
      providerId: 'openai',
      modelId: '',
      providersConfig: {
        ...store.getState().providersConfig,
        openai: { ...store.getState().providersConfig.openai, apiKey: 'sk-client' },
      },
    });

    // Server still offers nothing — openai is usable ONLY via the client key.
    mockServerResponse({});
    await store.getState().fetchServerProviders();

    expect(store.getState().providerId).toBe('openai');
    expect(store.getState().modelId).not.toBe('');
    expect(store.getState().modelId).toBe('gpt-4o');
  });

  it('first load: server-restricted model list is preferred over the built-in first model', async () => {
    const store = await getStore();

    // First ever sync, nothing selected, server restricts openai to a model
    // that is NOT the built-in first ('gpt-4o').
    mockServerResponse({ providers: { openai: { models: ['gpt-4o-mini'] } } });
    await store.getState().fetchServerProviders();

    expect(store.getState().providerId).toBe('openai');
    expect(store.getState().modelId).toBe('gpt-4o-mini');
  });

  it('first load: server-configured LLM provider auto-selects provider and a concrete model', async () => {
    const store = await getStore();

    mockServerResponse({ providers: { anthropic: { models: ['claude-sonnet-4-6'] } } });
    await store.getState().fetchServerProviders();

    expect(store.getState().providerId).toBe('anthropic');
    expect(store.getState().modelId).toBe('claude-sonnet-4-6');
  });

  it('API-key entry resolves a concrete model atomically (no waiting for next server sync)', async () => {
    const store = await getStore();

    // openai is the active provider but not yet usable (no key) and has no
    // model selected — the illegal interim state #580 must not persist.
    store.setState({ providerId: 'openai', modelId: '' });

    store.getState().setProviderConfig('openai', {
      apiKey: 'sk-client',
      baseUrl: '',
      requiresApiKey: true,
    });

    expect(store.getState().providerId).toBe('openai');
    expect(store.getState().modelId).toBe('gpt-4o');
  });

  it('preserves an alias wire ID when provider config contains its canonical model', async () => {
    const store = await getStore();
    store.setState({
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      providersConfig: {
        ...store.getState().providersConfig,
        openai: {
          ...store.getState().providersConfig.openai,
          apiKey: 'sk-client',
          models: [{ id: 'gpt-5.6', name: 'GPT-5.6 Sol' }],
        },
      },
    });

    store.getState().setProviderConfig('openai', { baseUrl: 'https://api.openai.com/v1' });

    expect(store.getState().modelId).toBe('gpt-5.6-sol');
  });

  it('configuring a non-active provider does not hijack the current selection', async () => {
    const store = await getStore();

    mockServerResponse({});
    await store.getState().fetchServerProviders();
    store.setState({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      providersConfig: {
        ...store.getState().providersConfig,
        anthropic: { ...store.getState().providersConfig.anthropic, apiKey: 'sk-a' },
      },
    });

    store.getState().setProviderConfig('openai', {
      apiKey: 'sk-o',
      baseUrl: '',
      requiresApiKey: true,
    });

    expect(store.getState().providerId).toBe('anthropic');
    expect(store.getState().modelId).toBe('claude-sonnet-4-6');
  });

  it('switching image provider resolves the new provider model (not a stale one)', async () => {
    const store = await getStore();

    // Start on seedream with a stale/foreign model id selected.
    store.setState({ imageProviderId: 'seedream', imageModelId: 'stale-model' });
    store.getState().setImageProvider('qwen-image');

    expect(store.getState().imageProviderId).toBe('qwen-image');
    expect(store.getState().imageModelId).toBe('qwen-image-max');
  });

  it('switching video provider resolves the new provider model (not a stale one)', async () => {
    const store = await getStore();

    // Default state is seedance/doubao-seedance…; switch to kling.
    store.getState().setVideoProvider('kling');

    expect(store.getState().videoProviderId).toBe('kling');
    expect(store.getState().videoModelId).toBe('kling-v2-6');
  });

  it('deleting the selected custom image model resolves back to a valid model', async () => {
    const store = await getStore();

    store.getState().setImageProvider('seedream');
    store.getState().setImageProviderConfig('seedream', {
      customModels: [{ id: 'my-custom-image', name: 'Custom' }],
    });
    store.getState().setImageModelId('my-custom-image');
    expect(store.getState().imageModelId).toBe('my-custom-image');

    // Delete the selected custom model — selection must not stay stale.
    store.getState().setImageProviderConfig('seedream', { customModels: [] });

    expect(store.getState().imageModelId).toBe('doubao-seedream-5-0-260128');
  });

  it('deleting the selected custom video model resolves back to a valid model', async () => {
    const store = await getStore();

    store.getState().setVideoProvider('seedance');
    store.getState().setVideoProviderConfig('seedance', {
      customModels: [{ id: 'my-custom-video', name: 'Custom' }],
    });
    store.getState().setVideoModelId('my-custom-video');
    expect(store.getState().videoModelId).toBe('my-custom-video');

    store.getState().setVideoProviderConfig('seedance', { customModels: [] });

    expect(store.getState().videoModelId).toBe('doubao-seedance-2-0-260128');
  });

  it('deleting the selected provider (bulk setProvidersConfig) does not keep an invalid selection', async () => {
    const store = await getStore();
    const base = store.getState().providersConfig;

    // Built-ins require a key and have none → unusable. A custom provider is
    // the only usable one and is the active selection.
    const stripped = Object.fromEntries(
      Object.entries(base).map(([id, c]) => [id, { ...c, apiKey: '', isServerConfigured: false }]),
    ) as typeof base;
    const withCustom = {
      ...stripped,
      'custom-tencent': {
        ...base.openai,
        apiKey: 'sk-t',
        baseUrl: 'https://tencent.example/v1',
        models: [{ id: 'hy3-preview', name: 'Hy3' }],
        name: 'Tencent',
        requiresApiKey: true,
      },
    } as typeof base;

    store.setState({
      providersConfig: withCustom,
      providerId: 'custom-tencent',
      modelId: 'hy3-preview',
    });

    // Delete it via the real delete path (the bulk config setter).
    store.getState().setProvidersConfig(stripped);

    // No usable provider remains ⇒ State A. Selection must NOT point at the
    // deleted provider, nor at an unusable built-in (e.g. openai + a model).
    expect(store.getState().providerId).not.toBe('custom-tencent');
    expect(store.getState().providerId).toBe('');
    expect(store.getState().modelId).toBe('');
  });

  it('clearing the selected provider API key (it becomes invalid) drops the stale selection', async () => {
    const store = await getStore();
    const base = store.getState().providersConfig;

    const stripped = Object.fromEntries(
      Object.entries(base).map(([id, c]) => [id, { ...c, apiKey: '', isServerConfigured: false }]),
    ) as typeof base;
    const withCustom = {
      ...stripped,
      'custom-tencent': {
        ...base.openai,
        apiKey: 'sk-t',
        baseUrl: 'https://tencent.example/v1',
        models: [{ id: 'hy3-preview', name: 'Hy3' }],
        name: 'Tencent',
        requiresApiKey: true,
      },
    } as typeof base;

    store.setState({
      providersConfig: withCustom,
      providerId: 'custom-tencent',
      modelId: 'hy3-preview',
    });

    // The realistic case: user clears the selected provider's key in Settings
    // → it becomes invalid. The selection must NOT stay on it.
    store.getState().setProviderConfig('custom-tencent', { apiKey: '' });

    expect(store.getState().providerId).not.toBe('custom-tencent');
    expect(store.getState().providerId).toBe('');
    expect(store.getState().modelId).toBe('');
  });

  it('clearing a non-selected provider key keeps the still-usable current selection', async () => {
    const store = await getStore();
    const base = store.getState().providersConfig;

    const stripped = Object.fromEntries(
      Object.entries(base).map(([id, c]) => [id, { ...c, apiKey: '', isServerConfigured: false }]),
    ) as typeof base;
    const withTwo = {
      ...stripped,
      'custom-a': {
        ...base.openai,
        apiKey: 'sk-a',
        baseUrl: 'https://a.example/v1',
        models: [{ id: 'a-1', name: 'A1' }],
        name: 'A',
        requiresApiKey: true,
      },
      'custom-b': {
        ...base.openai,
        apiKey: 'sk-b',
        baseUrl: 'https://b.example/v1',
        models: [{ id: 'b-1', name: 'B1' }],
        name: 'B',
        requiresApiKey: true,
      },
    } as typeof base;

    store.setState({
      providersConfig: withTwo,
      providerId: 'custom-a',
      modelId: 'a-1',
    });

    store.getState().setProviderConfig('custom-b', { apiKey: '' });

    expect(store.getState().providerId).toBe('custom-a');
    expect(store.getState().modelId).toBe('a-1');
  });

  it('deleting a non-selected provider keeps the still-usable current selection', async () => {
    const store = await getStore();
    const base = store.getState().providersConfig;

    const stripped = Object.fromEntries(
      Object.entries(base).map(([id, c]) => [id, { ...c, apiKey: '', isServerConfigured: false }]),
    ) as typeof base;
    const withTwoCustom = {
      ...stripped,
      'custom-a': {
        ...base.openai,
        apiKey: 'sk-a',
        baseUrl: 'https://a.example/v1',
        models: [{ id: 'a-1', name: 'A1' }],
        name: 'A',
        requiresApiKey: true,
      },
      'custom-b': {
        ...base.openai,
        apiKey: 'sk-b',
        baseUrl: 'https://b.example/v1',
        models: [{ id: 'b-1', name: 'B1' }],
        name: 'B',
        requiresApiKey: true,
      },
    } as typeof base;

    store.setState({
      providersConfig: withTwoCustom,
      providerId: 'custom-a',
      modelId: 'a-1',
    });

    const withoutB = { ...withTwoCustom };
    delete (withoutB as Record<string, unknown>)['custom-b'];
    store.getState().setProvidersConfig(withoutB as typeof base);

    expect(store.getState().providerId).toBe('custom-a');
    expect(store.getState().modelId).toBe('a-1');
  });
});

describe('settings merge migration — custom provider baseUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    mockFetch.mockReset();
  });

  it('promotes defaultBaseUrl into baseUrl for legacy custom providers', async () => {
    const { promoteLegacyCustomProviderBaseUrls } = await import('@/lib/store/settings');
    const state = {
      providersConfig: {
        'custom-123': {
          apiKey: '',
          baseUrl: '',
          models: [{ id: 'test-model', name: 'Test Model' }],
          name: 'Legacy Custom',
          type: 'openai',
          defaultBaseUrl: 'https://example.com/v1',
          requiresApiKey: true,
          isBuiltIn: false,
        },
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentionally partial for unit test
    promoteLegacyCustomProviderBaseUrls(state as any);

    expect(state.providersConfig['custom-123'].baseUrl).toBe('https://example.com/v1');
    expect(state.providersConfig['custom-123'].defaultBaseUrl).toBe('https://example.com/v1');
  });

  it('does not promote defaultBaseUrl for built-in providers', async () => {
    const { promoteLegacyCustomProviderBaseUrls } = await import('@/lib/store/settings');
    const state = {
      providersConfig: {
        openai: {
          apiKey: '',
          baseUrl: '',
          models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
          name: 'OpenAI',
          type: 'openai',
          defaultBaseUrl: 'https://persisted-openai.example/v1',
          requiresApiKey: true,
          isBuiltIn: true,
        },
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentionally partial for unit test
    promoteLegacyCustomProviderBaseUrls(state as any);

    expect(state.providersConfig.openai.baseUrl).toBe('');
    expect(state.providersConfig.openai.defaultBaseUrl).toBe('https://persisted-openai.example/v1');
  });
});

describe('settings store — outline review preference', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    mockFetch.mockReset();
  });

  async function getStore() {
    const { useSettingsStore } = await import('@/lib/store/settings');
    return useSettingsStore;
  }

  it('defaults reviewOutlineEnabled to false', async () => {
    const store = await getStore();

    expect(store.getState().reviewOutlineEnabled).toBe(false);
  });

  it('toggles reviewOutlineEnabled', async () => {
    const store = await getStore();

    store.getState().setReviewOutlineEnabled(true);

    expect(store.getState().reviewOutlineEnabled).toBe(true);
  });

  it('rehydrates older persisted settings without the outline flag to false', async () => {
    storage.set(
      'settings-storage',
      JSON.stringify({
        state: {
          providerId: 'openai',
          modelId: 'gpt-4o',
          autoConfigApplied: true,
        },
        version: 2,
      }),
    );

    const store = await getStore();

    expect(store.getState().reviewOutlineEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TTS provider enablement (#665)
// ---------------------------------------------------------------------------

describe('TTS provider enablement (#665)', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    mockFetch.mockReset();
  });

  async function getStore() {
    const { useSettingsStore } = await import('@/lib/store/settings');
    return useSettingsStore;
  }

  it('browser-native TTS is OFF by default (fresh install, opt-in)', async () => {
    const store = await getStore();
    expect(store.getState().ttsProvidersConfig['browser-native-tts'].enabled).toBe(false);
  });

  it('TTS master toggle is OFF by default on a fresh install', async () => {
    const store = await getStore();
    expect(store.getState().ttsEnabled).toBe(false);
  });

  it('first server-sync auto-enables TTS when a server provider exists', async () => {
    mockServerResponse({ tts: { 'openai-tts': {} } });
    const store = await getStore();
    expect(store.getState().ttsEnabled).toBe(false);
    await store.getState().fetchServerProviders();
    expect(store.getState().ttsEnabled).toBe(true);
  });

  it('server-sync does NOT auto-enable TTS when no provider is configured', async () => {
    mockServerResponse({ tts: {} });
    const store = await getStore();
    await store.getState().fetchServerProviders();
    expect(store.getState().ttsEnabled).toBe(false);
  });

  it('non-browser-native built-ins default enabled:true (configured ⇒ visible)', async () => {
    const store = await getStore();
    // azure-tts is in the mocked registry; it must default ON so a configured /
    // server-managed provider is never hidden by a stale default.
    expect(store.getState().ttsProvidersConfig['azure-tts'].enabled).toBe(true);
  });

  it('v3→v4 migration normalizes stale enabled flags (others ON, browser-native OFF)', async () => {
    storage.set(
      'settings-storage',
      JSON.stringify({
        version: 3,
        state: {
          ttsProvidersConfig: {
            'openai-tts': { apiKey: '', baseUrl: '', enabled: true },
            // stale default-false on a configured-capable provider — must flip ON
            'azure-tts': { apiKey: '', baseUrl: '', enabled: false },
            // legacy default-true browser-native — must flip OFF
            'browser-native-tts': { apiKey: '', baseUrl: '', enabled: true },
          },
          asrProvidersConfig: {},
        },
      }),
    );
    const store = await getStore();
    const cfg = store.getState().ttsProvidersConfig;
    expect(cfg['azure-tts'].enabled).toBe(true);
    expect(cfg['browser-native-tts'].enabled).toBe(false);
  });

  it('server force-disable sets serverDisabled and does NOT mark the provider managed', async () => {
    mockServerResponse({ tts: { 'openai-tts': { disabled: true } } });
    const store = await getStore();
    await store.getState().fetchServerProviders();
    const cfg = store.getState().ttsProvidersConfig['openai-tts'];
    expect(cfg.serverDisabled).toBe(true);
    expect(cfg.isServerConfigured).toBe(false);
  });

  it('a server-managed (not disabled) provider is marked configured, not disabled', async () => {
    mockServerResponse({ tts: { 'openai-tts': {} } });
    const store = await getStore();
    await store.getState().fetchServerProviders();
    const cfg = store.getState().ttsProvidersConfig['openai-tts'];
    expect(cfg.isServerConfigured).toBe(true);
    expect(cfg.serverDisabled).toBe(false);
  });

  it('clears serverDisabled when a later sync no longer reports the provider disabled', async () => {
    const store = await getStore();
    mockServerResponse({ tts: { 'openai-tts': { disabled: true } } });
    await store.getState().fetchServerProviders();
    expect(store.getState().ttsProvidersConfig['openai-tts'].serverDisabled).toBe(true);
    mockServerResponse({ tts: {} });
    await store.getState().fetchServerProviders();
    expect(store.getState().ttsProvidersConfig['openai-tts'].serverDisabled).toBe(false);
  });
});
