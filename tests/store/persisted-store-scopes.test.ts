/**
 * Which KV scope each persisted store declares.
 *
 * The scope is a contract, not a tuning knob: `device` values never leave the
 * machine under any backend, `account` values are user data a server-backed
 * deployment may sync across devices. Flipping one silently changes where a
 * user's data can travel, so it is asserted here rather than left to a reader
 * of the store file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserKVStore } from '@openmaic/storage';

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

/** Poll the KV scope: persist writes are asynchronous now. */
function persistedIn(scope: 'device' | 'account', name: string) {
  return vi.waitFor(async () => {
    const blob = await kv.get<{ state: Record<string, unknown> }>(name, scope);
    expect(blob).not.toBeNull();
    return blob!.state;
  });
}

beforeEach(() => {
  backing.clear();
  vi.resetModules();
});

describe('settings store', () => {
  it('persists under the account scope', async () => {
    const { useSettingsStore } = await import('@/lib/store/settings');
    await useSettingsStore.persist.rehydrate();

    useSettingsStore.getState().setPlaybackSpeed(1.5);

    expect(await persistedIn('account', 'settings-storage')).toMatchObject({ playbackSpeed: 1.5 });
    expect(await kv.get('settings-storage', 'device')).toBeNull();
  });

  it('writes nothing under the raw pre-cutover key', async () => {
    const { useSettingsStore } = await import('@/lib/store/settings');
    await useSettingsStore.persist.rehydrate();

    useSettingsStore.getState().setPlaybackSpeed(1.25);
    await persistedIn('account', 'settings-storage');

    expect(localStorageStub.getItem('settings-storage')).toBeNull();
  });

  it('adopts an existing raw blob on first load', async () => {
    localStorageStub.setItem(
      'settings-storage',
      JSON.stringify({ state: { playbackSpeed: 2 }, version: 4 }),
    );

    const { useSettingsStore } = await import('@/lib/store/settings');
    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().playbackSpeed).toBe(2);
    expect(localStorageStub.getItem('settings-storage')).toBeNull();
    expect(await persistedIn('account', 'settings-storage')).toMatchObject({ playbackSpeed: 2 });
  });
});

/**
 * The pre-persist keys (`llmModel` / `providersConfig` / …) used to be read
 * synchronously in the store initializer, guarded by "does the raw
 * `settings-storage` key exist?". Moving the blob into the KVStore removes that
 * key, so the guard would never fire again and every load would republish
 * whatever those keys still hold — including credentials the user deleted long
 * ago. They now run once, through the persist layer.
 */
describe('settings store — pre-persist migration', () => {
  const ANCIENT_KEY = 'sk-ancient-should-not-resurrect';

  function seedPrePersistKeys() {
    localStorageStub.setItem('llmModel', 'openai:gpt-4o');
    localStorageStub.setItem(
      'providersConfig',
      JSON.stringify({ openai: { apiKey: ANCIENT_KEY } }),
    );
  }

  it('adopts the pre-persist keys once, through hydration', async () => {
    seedPrePersistKeys();

    const { useSettingsStore } = await import('@/lib/store/settings');
    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().modelId).toBe('gpt-4o');
    expect(useSettingsStore.getState().providersConfig.openai?.apiKey).toBe(ANCIENT_KEY);
    expect(await persistedIn('account', 'settings-storage')).toMatchObject({ modelId: 'gpt-4o' });
  });

  it('never puts them in observable state before hydration', async () => {
    seedPrePersistKeys();

    const { useSettingsStore } = await import('@/lib/store/settings');

    // This is the first frame: a component reading providersConfig here (as the
    // home page does to gate generation) must not see a resurrected key.
    expect(useSettingsStore.getState().providersConfig.openai?.apiKey).toBeFalsy();
    expect(useSettingsStore.getState().modelId).toBe('');
  });

  it('stops re-reading them once the migration has been adopted', async () => {
    seedPrePersistKeys();

    const first = await import('@/lib/store/settings');
    await first.useSettingsStore.persist.rehydrate();
    expect(first.useSettingsStore.getState().providersConfig.openai?.apiKey).toBe(ANCIENT_KEY);

    // The user removes the key through the UI, which persists to the KV scope.
    first.useSettingsStore.getState().setProviderConfig('openai', { apiKey: '' });
    await vi.waitFor(async () => {
      const state = await persistedIn('account', 'settings-storage');
      expect((state.providersConfig as Record<string, { apiKey?: string }>).openai.apiKey).toBe('');
    });

    // Reload. The stale `providersConfig` key is still sitting in localStorage
    // (other readers own it), and must not come back.
    vi.resetModules();
    const second = await import('@/lib/store/settings');
    await second.useSettingsStore.persist.rehydrate();

    expect(localStorageStub.getItem('providersConfig')).not.toBeNull();
    expect(second.useSettingsStore.getState().providersConfig.openai?.apiKey).toBe('');
  });

  it('leaves the pre-persist keys in place for their other readers', async () => {
    seedPrePersistKeys();

    const { useSettingsStore } = await import('@/lib/store/settings');
    await useSettingsStore.persist.rehydrate();

    // lib/ai/providers.ts still reads `providersConfig` for custom providers.
    expect(localStorageStub.getItem('providersConfig')).not.toBeNull();
    expect(localStorageStub.getItem('llmModel')).toBe('openai:gpt-4o');
  });
});

describe('user profile store', () => {
  it('persists under the account scope', async () => {
    const { useUserProfileStore } = await import('@/lib/store/user-profile');
    await useUserProfileStore.persist.rehydrate();

    useUserProfileStore.getState().setNickname('Ada');

    expect(await persistedIn('account', 'user-profile-storage')).toMatchObject({ nickname: 'Ada' });
    expect(await kv.get('user-profile-storage', 'device')).toBeNull();
    expect(localStorageStub.getItem('user-profile-storage')).toBeNull();
  });

  it('adopts an existing raw blob on first load', async () => {
    localStorageStub.setItem(
      'user-profile-storage',
      JSON.stringify({ state: { nickname: 'Ada', bio: 'hi', avatar: '/avatars/user.png' } }),
    );

    const { useUserProfileStore } = await import('@/lib/store/user-profile');
    await useUserProfileStore.persist.rehydrate();

    expect(useUserProfileStore.getState().nickname).toBe('Ada');
    expect(localStorageStub.getItem('user-profile-storage')).toBeNull();
    expect(await persistedIn('account', 'user-profile-storage')).toMatchObject({ nickname: 'Ada' });
  });
});
