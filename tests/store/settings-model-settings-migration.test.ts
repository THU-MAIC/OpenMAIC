/**
 * The settings store's migration to version 5: the model settings this
 * browser kept are set aside for the one-time import into the workspace
 * (lib/legacy-browser-import/model-settings.ts).
 */
import { BrowserKVStore } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MODEL_SETTINGS_IMPORT_KEY } from '@/lib/legacy-browser-import/model-settings';

const backing = new Map<string, string>();
const localStorageStub: Storage = {
  get length() {
    return backing.size;
  },
  clear: () => backing.clear(),
  getItem: (k: string) => backing.get(k) ?? null,
  key: (i: number) => [...backing.keys()][i] ?? null,
  removeItem: (k: string) => void backing.delete(k),
  setItem: (k: string, v: string) => void backing.set(k, v),
};
vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

const kv = new BrowserKVStore({ storage: localStorageStub });

beforeEach(() => {
  backing.clear();
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
        asrEnabled: false,
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

  it('sets nothing aside when the browser kept no model settings', async () => {
    await hydrate({ asrEnabled: false, playbackSpeed: 1.25 }, 4);
    expect(localStorageStub.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
  });

  it('does not run again for a state already at version 5', async () => {
    await hydrate(
      {
        providerId: 'openai',
        modelId: 'gpt-5',
        providersConfig: { openai: { apiKey: 'sk-browser', baseUrl: '' } },
      },
      5,
    );
    expect(localStorageStub.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
  });
});
