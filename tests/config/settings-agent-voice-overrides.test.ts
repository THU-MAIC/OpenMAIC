/**
 * agentVoiceOverrides + agentSelectionIsUserSet: persisted UI preferences (the
 * home for AgentBar choices — registry agent records are reset from
 * code/IndexedDB on every load and must not own user picks).
 *
 * localStorage is stubbed and the store imported per-test so the persist
 * rehydration path (merge of an existing blob) is exercised for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

async function freshStore(persistedState?: Record<string, unknown>) {
  vi.resetModules();
  storage.clear();
  if (persistedState) {
    storage.set('settings-storage', JSON.stringify({ state: persistedState, version: 4 }));
  }
  const { useSettingsStore } = await import('@/lib/store/settings');
  return useSettingsStore;
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
    // partialize omits the field) — sync storage writes synchronously.
    const blob = JSON.parse(storage.get('settings-storage')!);
    expect(blob.state.agentVoiceOverrides).toEqual({
      'default-3': { providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Cherry' },
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
    expect(JSON.parse(storage.get('settings-storage')!).state.agentSelectionIsUserSet).toBe(true);
    store.getState().setAgentSelectionIsUserSet(false);
    expect(store.getState().agentSelectionIsUserSet).toBe(false);
  });
});
