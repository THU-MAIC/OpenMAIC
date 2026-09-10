/**
 * agentVoiceOverrides + agentSelectionIsUserSet: persisted UI preferences (the
 * home for AgentBar choices — registry agent records are reset from
 * code/IndexedDB on every load and must not own user picks).
 *
 * localStorage is stubbed and the store imported per-test so the persist
 * rehydration path (merge of an existing blob) is exercised for real. A
 * pre-existing blob is seeded into the KVStore `account` scope — the store
 * reads only the KV scope and does not migrate any legacy raw key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserKVStore } from '@openmaic/storage';

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => void storage.clear(),
  key: () => null,
  length: 0,
};
vi.stubGlobal('localStorage', localStorageStub);
// Several init paths guard on `typeof window` before touching storage.
vi.stubGlobal('window', { localStorage: localStorageStub });

// The blob is written and read through the KVStore's `account` scope, so seed
// and read it back through the same primitive instead of guessing its key
// layout. There is no legacy-key migration, so a pre-existing blob has to be
// in the KV scope to be picked up.
const persistKv = new BrowserKVStore({ storage: localStorageStub as unknown as Storage });

async function freshStore(persistedState?: Record<string, unknown>) {
  vi.resetModules();
  storage.clear();
  if (persistedState) {
    await persistKv.set('settings-storage', { state: persistedState, version: 4 }, 'account');
  }
  const { useSettingsStore } = await import('@/lib/store/settings');
  // persist hydrates asynchronously now that it reads through the KVStore —
  // await it so the assertions never race the rehydrate.
  await useSettingsStore.persist.rehydrate();
  return useSettingsStore;
}
async function readPersistedState(): Promise<Record<string, unknown>> {
  return await vi.waitFor(async () => {
    const blob = await persistKv.get<{ state: Record<string, unknown> }>(
      'settings-storage',
      'account',
    );
    expect(blob).not.toBeNull();
    return blob!.state;
  });
}

describe('agentVoiceOverrides', () => {
  beforeEach(() => storage.clear());

  it('defaults to an empty map', async () => {
    const store = await freshStore();
    expect(store.getState().agentVoiceOverrides).toEqual({});
  });

  it('setAgentVoiceOverride adds, replaces, and deletes entries per agent id', async () => {
    const store = await freshStore();
    const { setAgentVoiceOverride } = store.getState();
    setAgentVoiceOverride('default-2', { providerId: 'qwen-tts', voiceId: 'Dylan' });
    setAgentVoiceOverride('default-3', {
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-flash',
      voiceId: 'Cherry',
    });
    setAgentVoiceOverride('default-2', { providerId: 'qwen-tts', voiceId: 'Serena' });
    expect(store.getState().agentVoiceOverrides).toEqual({
      'default-2': { providerId: 'qwen-tts', voiceId: 'Serena' },
      'default-3': { providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Cherry' },
    });

    // undefined deletes — the symmetric way back to deterministic auto-assignment
    setAgentVoiceOverride('default-2', undefined);
    expect(store.getState().agentVoiceOverrides).toEqual({
      'default-3': { providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Cherry' },
    });

    // The write must actually reach storage (would break if a future
    // partialize omits the field). Poll on the assertion, not on a blob
    // merely existing: hydration may already have left one there.
    await vi.waitFor(async () => {
      expect((await readPersistedState()).agentVoiceOverrides).toEqual({
        'default-3': { providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Cherry' },
      });
    });
  });

  it('survives persist rehydration of an existing blob', async () => {
    const store = await freshStore({
      agentVoiceOverrides: { 'default-2': { providerId: 'qwen-tts', voiceId: 'Dylan' } },
      agentSelectionIsUserSet: true,
    });
    expect(store.getState().agentVoiceOverrides).toEqual({
      'default-2': { providerId: 'qwen-tts', voiceId: 'Dylan' },
    });
    expect(store.getState().agentSelectionIsUserSet).toBe(true);
  });

  it('defaults to {} when rehydrating a pre-existing blob without the field', async () => {
    const store = await freshStore({ ttsSpeed: 1.25 });
    expect(store.getState().agentVoiceOverrides).toEqual({});
    expect(store.getState().agentSelectionIsUserSet).toBe(false);
    expect(store.getState().ttsSpeed).toBe(1.25);
  });
});

describe('agentSelectionIsUserSet', () => {
  it('defaults to false and is settable', async () => {
    const store = await freshStore();
    expect(store.getState().agentSelectionIsUserSet).toBe(false);
    store.getState().setAgentSelectionIsUserSet(true);
    expect(store.getState().agentSelectionIsUserSet).toBe(true);
    await vi.waitFor(async () => {
      expect((await readPersistedState()).agentSelectionIsUserSet).toBe(true);
    });
    store.getState().setAgentSelectionIsUserSet(false);
    expect(store.getState().agentSelectionIsUserSet).toBe(false);
  });
});

describe('Qwen voice/model self-healing', () => {
  it('repairs a persisted VC-model plus catalog-voice wedge', async () => {
    const store = await freshStore();
    store.setState((state) => ({
      ttsProviderId: 'qwen-tts',
      ttsVoice: 'vendor-clone-id',
      ttsProvidersConfig: {
        ...state.ttsProvidersConfig,
        'qwen-tts': {
          ...state.ttsProvidersConfig['qwen-tts'],
          modelId: 'qwen3-tts-vc-2026-01-22',
        },
      },
    }));

    store.getState().setTTSVoice('Cherry');
    expect(store.getState().ttsVoice).toBe('Cherry');
    expect(store.getState().ttsProvidersConfig['qwen-tts']?.modelId).toBe('qwen3-tts-flash');
  });

  it('does not pin the provider model when selecting a clone voice', async () => {
    const store = await freshStore();
    store.setState((state) => ({
      ttsProviderId: 'qwen-tts',
      ttsProvidersConfig: {
        ...state.ttsProvidersConfig,
        'qwen-tts': {
          ...state.ttsProvidersConfig['qwen-tts'],
          modelId: 'qwen3-tts-flash',
        },
      },
    }));

    store.getState().setTTSVoice('vendor-clone-id');
    expect(store.getState().ttsProvidersConfig['qwen-tts']?.modelId).toBe('qwen3-tts-flash');
  });
});
