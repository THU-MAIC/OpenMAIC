/**
 * Tests for fetchServerProviders() — verifying that the settings store
 * correctly reflects server-side provider availability changes.
 *
 * Core invariant: after server sync, the set of models/providers a user
 * can select in the UI must match what the server currently supports.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

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
      models: [{ id: 'doubao-seedance-1-5-pro-251215', name: 'Seedance 1.5 Pro' }],
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
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Full server response shape */
interface MockServerResponse {
  providers?: Record<string, { models?: string[]; baseUrl?: string }>;
  tts?: Record<string, { baseUrl?: string }>;
  asr?: Record<string, { baseUrl?: string }>;
  pdf?: Record<string, { baseUrl?: string }>;
  image?: Record<string, Record<string, never>>;
  video?: Record<string, Record<string, never>>;
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
    const isUsable = !config.requiresApiKey || !!config.apiKey || !!config.isServerConfigured;
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
    store.getState().setVideoModelId('doubao-seedance-1-5-pro-251215');

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
    store.getState().setVideoModelId('doubao-seedance-1-5-pro-251215');

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
    expect(store.getState().videoModelId).toBe('doubao-seedance-1-5-pro-251215');
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
