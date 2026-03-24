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
  ASR_PROVIDERS: {},
  DEFAULT_TTS_VOICES: {},
}));

vi.mock('@/lib/audio/types', () => ({}));

vi.mock('@/lib/media/image-providers', () => ({
  IMAGE_PROVIDERS: {},
}));

vi.mock('@/lib/media/video-providers', () => ({
  VIDEO_PROVIDERS: {},
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

/** Build a standard /api/server-providers response */
function serverResponse(providers: Record<string, { models?: string[]; baseUrl?: string }> = {}) {
  return {
    providers,
    tts: {},
    asr: {},
    pdf: {},
    image: {},
    video: {},
    webSearch: {},
  };
}

function mockServerProviders(
  providers: Record<string, { models?: string[]; baseUrl?: string }> = {},
) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => serverResponse(providers),
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
    mockServerProviders({
      openai: { models: ['gpt-4o'] },
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
    mockServerProviders({
      openai: {}, // no models field = no restriction
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
    mockServerProviders({
      openai: { models: ['gpt-4o', 'gpt-4o-mini'] },
    });
    await store.getState().fetchServerProviders();
    expect(store.getState().providersConfig.openai.models.map((m) => m.id)).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ]);

    // Round 2: server removes gpt-4o-mini
    mockServerProviders({
      openai: { models: ['gpt-4o'] },
    });
    await store.getState().fetchServerProviders();
    const modelIds = store.getState().providersConfig.openai.models.map((m) => m.id);
    expect(modelIds).toEqual(['gpt-4o']);
    expect(modelIds).not.toContain('gpt-4o-mini');
  });

  // ---- Provider availability flags ----

  it('marks provider as server-configured when present in response', async () => {
    const store = await getStore();
    mockServerProviders({
      openai: { models: ['gpt-4o'] },
    });

    await store.getState().fetchServerProviders();

    expect(store.getState().providersConfig.openai.isServerConfigured).toBe(true);
  });

  it('resets isServerConfigured when provider disappears from response', async () => {
    const store = await getStore();

    // Round 1: openai is server-configured
    mockServerProviders({ openai: { models: ['gpt-4o'] } });
    await store.getState().fetchServerProviders();
    expect(store.getState().providersConfig.openai.isServerConfigured).toBe(true);

    // Round 2: openai is no longer in server response
    mockServerProviders({});
    await store.getState().fetchServerProviders();
    expect(store.getState().providersConfig.openai.isServerConfigured).toBe(false);
  });

  it('provider without client key and not server-configured has no usable path', async () => {
    const store = await getStore();
    mockServerProviders({}); // no server providers

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
    mockServerProviders({
      openai: { models: ['gpt-4o'] },
      // anthropic not in response
    });

    await store.getState().fetchServerProviders();

    expect(store.getState().providersConfig.openai.isServerConfigured).toBe(true);
    expect(store.getState().providersConfig.anthropic.isServerConfigured).toBe(false);
  });

  // ---- serverModels metadata ----

  it('stores serverModels metadata for downstream filtering', async () => {
    const store = await getStore();
    mockServerProviders({
      openai: { models: ['gpt-4o', 'gpt-4o-mini'] },
    });

    await store.getState().fetchServerProviders();

    expect(store.getState().providersConfig.openai.serverModels).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('clears serverModels when provider removed from server', async () => {
    const store = await getStore();

    mockServerProviders({ openai: { models: ['gpt-4o'] } });
    await store.getState().fetchServerProviders();
    expect(store.getState().providersConfig.openai.serverModels).toEqual(['gpt-4o']);

    mockServerProviders({});
    await store.getState().fetchServerProviders();
    expect(store.getState().providersConfig.openai.serverModels).toBeUndefined();
  });

  // ---- Stale selection consistency ----

  // BUG: fetchServerProviders() updates providersConfig.models but never
  // validates the current modelId/providerId selection against the new list.
  // These tests document the desired fix — remove .fails() once implemented.

  it.fails('clears modelId when server removes the selected model', async () => {
    const store = await getStore();

    // User selects gpt-4o-mini while it's available
    store.getState().setModel('openai', 'gpt-4o-mini');
    expect(store.getState().modelId).toBe('gpt-4o-mini');

    // Server drops gpt-4o-mini
    mockServerProviders({ openai: { models: ['gpt-4o'] } });
    await store.getState().fetchServerProviders();

    // modelId should be cleared, not silently kept as a stale value
    expect(store.getState().modelId).toBe('');
  });

  it.fails(
    'clears providerId when entire provider loses server config and has no client key',
    async () => {
      const store = await getStore();

      // User on a server-only provider (no client key)
      store.getState().setModel('openai', 'gpt-4o');
      mockServerProviders({ openai: { models: ['gpt-4o'] } });
      await store.getState().fetchServerProviders();
      expect(store.getState().providersConfig.openai.isServerConfigured).toBe(true);

      // Server removes openai entirely — no client key either
      mockServerProviders({});
      await store.getState().fetchServerProviders();

      // Provider is unusable → selection should be cleared
      expect(store.getState().providerId).toBe('');
      expect(store.getState().modelId).toBe('');
    },
  );

  it.fails(
    'clears modelId when server narrows model list and selected model is excluded',
    async () => {
      const store = await getStore();

      // Round 1: user picks gpt-4-turbo
      mockServerProviders({ openai: { models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'] } });
      await store.getState().fetchServerProviders();
      store.getState().setModel('openai', 'gpt-4-turbo');

      // Round 2: server narrows to gpt-4o only
      mockServerProviders({ openai: { models: ['gpt-4o'] } });
      await store.getState().fetchServerProviders();

      // Selection should be cleared, not left pointing to unavailable model
      expect(store.getState().modelId).toBe('');
    },
  );

  it('keeps modelId when selected model is still available after server sync', async () => {
    const store = await getStore();

    store.getState().setModel('openai', 'gpt-4o');
    mockServerProviders({ openai: { models: ['gpt-4o', 'gpt-4o-mini'] } });
    await store.getState().fetchServerProviders();

    // gpt-4o is still available — selection should be preserved
    expect(store.getState().providerId).toBe('openai');
    expect(store.getState().modelId).toBe('gpt-4o');
  });

  // ---- Error handling ----

  it('does not modify state when fetch returns non-ok response', async () => {
    const store = await getStore();

    // First, set up a known state
    mockServerProviders({ openai: { models: ['gpt-4o'] } });
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
