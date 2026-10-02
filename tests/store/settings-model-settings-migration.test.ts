/**
 * The settings store's migration to version 5: the model settings this
 * browser kept are set aside for the one-time import into the workspace
 * (lib/legacy-browser-import/model-settings.ts).
 */
import { BrowserKVStore } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MODEL_SETTINGS_IMPORT_KEY } from '@/lib/legacy-browser-import/model-settings';
import { MODEL_SETTINGS_UNIMPORTED_KEY } from '@/lib/legacy-browser-import/model-settings-unimported';

const backing = new Map<string, string>();
/** Keys whose writes fail (a full storage). */
const failing = new Set<string>();
const localStorageStub: Storage = {
  get length() {
    return backing.size;
  },
  clear: () => backing.clear(),
  getItem: (k: string) => backing.get(k) ?? null,
  key: (i: number) => [...backing.keys()][i] ?? null,
  removeItem: (k: string) => void backing.delete(k),
  setItem: (k: string, v: string) => {
    if (failing.has(k)) {
      throw Object.assign(new Error('The quota has been exceeded.'), {
        name: 'QuotaExceededError',
      });
    }
    backing.set(k, v);
  },
};
vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

const kv = new BrowserKVStore({ storage: localStorageStub });

beforeEach(() => {
  backing.clear();
  failing.clear();
  vi.resetModules();
});

async function hydrate(state: Record<string, unknown>, version: number) {
  await kv.set('settings-storage', { state, version }, 'account');
  const { useSettingsStore } = await import('@/lib/store/settings');
  await useSettingsStore.persist.rehydrate();
  return useSettingsStore;
}

describe('settings store v4 → v5', () => {
  it('sets the browser model settings aside for import', async () => {
    const store = await hydrate(
      {
        providerId: 'openai',
        modelId: 'gpt-5',
        providersConfig: { openai: { apiKey: 'sk-browser', baseUrl: '' } },
        playbackSpeed: 1.5,
      },
      4,
    );

    expect(JSON.parse(localStorageStub.getItem(MODEL_SETTINGS_IMPORT_KEY)!)).toEqual({
      providers: { openai: { preset: 'openai', apiKey: 'sk-browser' } },
      slots: { llm: 'openai:gpt-5' },
    });
    // Preferences carry over.
    expect(store.getState().playbackSpeed).toBe(1.5);
  });

  it('drops every provider field and keeps the voice with the provider it was picked for', async () => {
    const store = await hydrate(
      {
        providerId: 'openai',
        modelId: 'gpt-5',
        providersConfig: { openai: { apiKey: 'sk-browser', baseUrl: '' } },
        llmStageRoutes: { 'scene-content:slide': { providerId: 'openai', modelId: 'gpt-5' } },
        tokenPlanEnrollments: {},
        ttsEnabled: true,
        ttsProviderId: 'qwen-tts',
        ttsVoice: 'Cherry',
        ttsSpeed: 1.2,
        ttsProvidersConfig: { 'qwen-tts': { apiKey: 'sk-tts', baseUrl: '' } },
        imageGenerationEnabled: true,
        asrLanguage: 'en',
        selectedAgentIds: ['default-1'],
      },
      4,
    );

    const state = store.getState() as unknown as Record<string, unknown>;
    expect(state).toMatchObject({
      ttsVoice: 'Cherry',
      ttsVoiceProviderId: 'qwen-tts',
      ttsSpeed: 1.2,
      asrLanguage: 'en',
      selectedAgentIds: ['default-1'],
    });
    for (const field of [
      'providerId',
      'modelId',
      'providersConfig',
      'llmStageRoutes',
      'tokenPlanEnrollments',
      'ttsEnabled',
      'ttsProviderId',
      'ttsProvidersConfig',
      'imageGenerationEnabled',
    ]) {
      expect(state).not.toHaveProperty(field);
    }

    // What is written back holds no key.
    store.getState().setPlaybackSpeed(1.25);
    await vi.waitFor(async () => {
      const blob = await kv.get<{ state: Record<string, unknown>; version: number }>(
        'settings-storage',
        'account',
      );
      expect(blob?.state.playbackSpeed).toBe(1.25);
      expect(blob?.version).toBe(5);
      expect(JSON.stringify(blob)).not.toContain('sk-');
    });
  });

  it('sets nothing aside when the browser kept no model settings', async () => {
    await hydrate({ playbackSpeed: 1.25 }, 4);
    expect(localStorageStub.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
  });

  it('does not run again for a state already at version 5', async () => {
    const store = await hydrate(
      {
        providerId: 'openai',
        modelId: 'gpt-5',
        providersConfig: { openai: { apiKey: 'sk-browser', baseUrl: '' } },
      },
      5,
    );
    expect(localStorageStub.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
    // Fields of earlier builds never reach the state.
    expect(store.getState()).not.toHaveProperty('providersConfig');
  });

  it('keeps the keys when they cannot be set aside, and stages them on a later load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    failing.add(MODEL_SETTINGS_IMPORT_KEY);
    const store = await hydrate(
      {
        providerId: 'openai',
        modelId: 'gpt-5',
        providersConfig: { openai: { apiKey: 'sk-kept', baseUrl: '' } },
        playbackSpeed: 1.5,
      },
      4,
    );

    // Nothing was staged, so nothing was dropped: the old settings stay,
    // and the blob written back still holds them.
    expect(localStorageStub.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
    expect(store.getState().legacyModelSettings).toMatchObject({
      providersConfig: { openai: { apiKey: 'sk-kept' } },
    });
    await vi.waitFor(async () => {
      const blob = await kv.get<{ state: Record<string, unknown>; version: number }>(
        'settings-storage',
        'account',
      );
      expect(blob?.version).toBe(5);
      expect(JSON.stringify(blob?.state)).toContain('sk-kept');
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-kept');

    // Room again: the next load stages them and writes the store back without them.
    failing.clear();
    vi.resetModules();
    const { useSettingsStore } = await import('@/lib/store/settings');
    await useSettingsStore.persist.rehydrate();
    expect(JSON.parse(localStorageStub.getItem(MODEL_SETTINGS_IMPORT_KEY)!)).toEqual({
      providers: { openai: { preset: 'openai', apiKey: 'sk-kept' } },
      slots: { llm: 'openai:gpt-5' },
    });
    expect(useSettingsStore.getState().legacyModelSettings).toBeUndefined();
    expect(useSettingsStore.getState().playbackSpeed).toBe(1.5);
    await vi.waitFor(async () => {
      const blob = await kv.get<{ state: Record<string, unknown> }>('settings-storage', 'account');
      expect(JSON.stringify(blob?.state)).not.toContain('sk-kept');
    });
    warn.mockRestore();
  });

  it('normalises an older shape before setting it aside', async () => {
    await hydrate(
      {
        webSearchApiKey: 'tvly-old',
        webSearchEnabled: true,
        ttsModel: 'openai-tts',
        ttsModelId: 'tts-1-hd',
        ttsEnabled: true,
        ttsProvidersConfig: { 'openai-tts': { apiKey: 'sk-tts' } },
      },
      1,
    );
    expect(JSON.parse(localStorageStub.getItem(MODEL_SETTINGS_IMPORT_KEY)!)).toEqual({
      providers: {
        'openai-tts': { preset: 'openai-tts', apiKey: 'sk-tts' },
        tavily: { preset: 'tavily', apiKey: 'tvly-old' },
      },
      slots: { tts: 'openai-tts:tts-1-hd', webSearch: 'tavily' },
    });
  });

  it('sets aside a keyless search service the user selected and switched on', async () => {
    await hydrate(
      {
        webSearchEnabled: true,
        webSearchProviderId: 'brave',
        webSearchProvidersConfig: { brave: { apiKey: '', baseUrl: '', enabled: true } },
        playbackSpeed: 1,
      },
      4,
    );
    expect(JSON.parse(localStorageStub.getItem(MODEL_SETTINGS_IMPORT_KEY)!)).toEqual({
      providers: { brave: { preset: 'brave' } },
      slots: { webSearch: 'brave' },
    });
  });
  it('keeps what cannot be proposed in the browser, with its keys, before dropping it', async () => {
    const store = await hydrate(
      {
        ttsProviderId: 'custom-tts-1',
        ttsProvidersConfig: {
          'custom-tts-1': {
            apiKey: 'sk-custom-tts',
            baseUrl: '',
            customName: 'My voice',
            customDefaultBaseUrl: 'https://tts.example.com',
          },
        },
      },
      4,
    );
    expect(store.getState()).not.toHaveProperty('ttsProvidersConfig');
    expect(store.getState().legacyModelSettings).toBeUndefined();
    expect(localStorageStub.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
    const kept = JSON.parse(localStorageStub.getItem(MODEL_SETTINGS_UNIMPORTED_KEY)!);
    expect(kept.items).toEqual([
      expect.objectContaining({
        id: 'tts:custom-tts-1',
        reason: 'custom-service',
        settings: expect.objectContaining({ apiKey: 'sk-custom-tts' }),
      }),
    ]);
  });

  it('keeps the old fields when what cannot be proposed cannot be kept', async () => {
    failing.add(MODEL_SETTINGS_UNIMPORTED_KEY);
    const store = await hydrate(
      {
        ttsProvidersConfig: {
          'custom-tts-1': { apiKey: 'sk-custom-tts', baseUrl: 'https://tts.example.com' },
        },
      },
      4,
    );
    expect(store.getState().legacyModelSettings).toMatchObject({
      ttsProvidersConfig: { 'custom-tts-1': { apiKey: 'sk-custom-tts' } },
    });
  });
});
