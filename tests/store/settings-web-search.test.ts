/**
 * Tests for web search settings store behaviour:
 * - Default tools pre-populated for the claude provider
 * - ensureBuiltInWebSearchProviders fills missing providers on rehydrate
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ai/providers', () => ({
  PROVIDERS: {
    openai: {
      id: 'openai',
      name: 'OpenAI',
      type: 'openai',
      defaultBaseUrl: 'https://api.openai.com/v1',
      requiresApiKey: true,
      icon: '',
      models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
    },
  },
}));

vi.mock('@/lib/audio/constants', () => ({
  TTS_PROVIDERS: {
    'browser-native-tts': {
      id: 'browser-native-tts',
      name: 'Browser Native TTS',
      requiresApiKey: false,
      defaultModelId: '',
      models: [],
      voices: [{ id: 'default', name: 'Default', language: 'en', gender: 'neutral' }],
      supportedFormats: ['browser'],
    },
  },
  ASR_PROVIDERS: {
    'browser-native': {
      id: 'browser-native',
      name: 'Browser Native ASR',
      requiresApiKey: false,
      defaultModelId: '',
      models: [],
      supportedLanguages: ['en'],
      supportedFormats: ['browser'],
    },
  },
  DEFAULT_TTS_VOICES: { 'browser-native-tts': 'default' },
}));

vi.mock('@/lib/audio/types', () => ({}));

vi.mock('@/lib/pdf/constants', () => ({
  PDF_PROVIDERS: { unpdf: { id: 'unpdf', requiresApiKey: false } },
}));

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

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
});

describe('web search store defaults', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
  });

  async function getStore() {
    const { useSettingsStore } = await import('@/lib/store/settings');
    return useSettingsStore;
  }

  it('pre-populates the default web_search tool for the claude provider', async () => {
    const store = await getStore();
    const claudeConfig = store.getState().webSearchProvidersConfig.claude;

    expect(claudeConfig.tools).toContainEqual({
      type: 'web_search_20260209',
      name: 'web_search',
    });
  });

  it('has at least one tool in the claude provider default config', async () => {
    const store = await getStore();
    const tools = store.getState().webSearchProvidersConfig.claude.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
  });

  it('populates claude provider config on rehydrate when missing from persisted state', async () => {
    // Simulate persisted state that only has tavily (old format before claude was added)
    storage.set(
      'openmaic-settings',
      JSON.stringify({
        state: {
          webSearchProviderId: 'tavily',
          webSearchProvidersConfig: {
            tavily: { apiKey: '', baseUrl: '', enabled: true },
            // claude missing intentionally
          },
        },
        version: 0,
      }),
    );

    const store = await getStore();
    const claudeConfig = store.getState().webSearchProvidersConfig.claude;

    expect(claudeConfig).toBeDefined();
    expect(claudeConfig.tools?.length).toBeGreaterThan(0);
  });

  it('setWebSearchProviderConfig persists tool changes', async () => {
    const store = await getStore();
    const newTools = [
      { type: 'web_search_20260209', name: 'web_search' },
      { type: 'custom_tool', name: 'my_tool' },
    ];

    store.getState().setWebSearchProviderConfig('claude', { tools: newTools });

    expect(store.getState().webSearchProvidersConfig.claude.tools).toEqual(newTools);
  });
});
