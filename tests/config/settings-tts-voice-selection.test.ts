import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applySelectableVoiceChoice,
  getSelectableProvidersWithVoices,
  resolveSelectableVoiceChoice,
} from '@/lib/audio/voice-resolver';

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => void storage.clear(),
  key: () => null,
  length: 0,
};

vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

async function freshStore() {
  vi.resetModules();
  storage.clear();
  const { useSettingsStore } = await import('@/lib/store/settings');
  return useSettingsStore;
}

describe('Settings TTS voice selection', () => {
  beforeEach(() => storage.clear());

  it('switches from a non-active provider and selects a compatible voice from the shared list', async () => {
    const store = await freshStore();
    store.setState({
      ttsProviderId: 'browser-native-tts',
      ttsVoice: 'default',
      ttsProvidersConfig: {
        ...store.getState().ttsProvidersConfig,
        'openai-tts': {
          ...store.getState().ttsProvidersConfig['openai-tts'],
          apiKey: 'test-key',
          enabled: true,
          modelId: 'tts-1',
        },
      },
    });

    const providers = getSelectableProvidersWithVoices(store.getState().ttsProvidersConfig);
    const choice = resolveSelectableVoiceChoice(providers, 'openai-tts', 'marin', 'tts-1');

    expect(choice).toEqual({
      providerId: 'openai-tts',
      voiceId: 'marin',
      modelId: 'gpt-4o-mini-tts',
    });

    applySelectableVoiceChoice(choice!, store.getState());

    expect(store.getState().ttsProviderId).toBe('openai-tts');
    expect(store.getState().ttsVoice).toBe('marin');
    expect(store.getState().ttsProvidersConfig['openai-tts']?.modelId).toBe('gpt-4o-mini-tts');
  });
});
