/**
 * Which KV scope each persisted store declares, and that neither store migrates
 * pre-cutover `localStorage` data.
 *
 * The scope is a contract, not a tuning knob: `device` values never leave the
 * machine under any backend, `account` values are user data a server-backed
 * deployment may sync across devices. Flipping one silently changes where a
 * user's data can travel, so it is asserted here rather than left to a reader
 * of the store file.
 *
 * Migration was removed entirely: an upgrading user reconfigures once. These
 * tests pin that a leftover raw key is ignored (the store hydrates to defaults)
 * and, for the two persist keys, best-effort purged.
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

/** Poll the KV scope: persist writes are asynchronous. */
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

  it('ignores an existing raw blob and purges it, rather than migrating it', async () => {
    localStorageStub.setItem('settings-storage', JSON.stringify({ state: { modelId: 'gpt-4o' } }));

    const { useSettingsStore } = await import('@/lib/store/settings');
    await useSettingsStore.persist.rehydrate();

    // The seeded value is not migrated — the store hydrates to its default.
    expect(useSettingsStore.getState().modelId).toBe('');
    // And the stale blob (which held plaintext API keys) is purged from
    // localStorage rather than left forever.
    expect(localStorageStub.getItem('settings-storage')).toBeNull();
    // Nothing was written to the KV scope from it either.
    expect(await kv.get('settings-storage', 'account')).toBeNull();
  });
});

describe('settings store — no pre-persist migration', () => {
  it('does not read the ancient llmModel / providersConfig keys into state', async () => {
    // These keys predate the persist middleware. Migration used to fold them in;
    // it is gone, so an upgrading user reconfigures once and the ancient
    // (possibly rotated) credentials never re-appear.
    const ANCIENT_KEY = 'sk-ancient-should-not-resurrect';
    localStorageStub.setItem('llmModel', 'openai:gpt-4o');
    localStorageStub.setItem(
      'providersConfig',
      JSON.stringify({ openai: { apiKey: ANCIENT_KEY } }),
    );

    const { useSettingsStore } = await import('@/lib/store/settings');
    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().modelId).toBe('');
    expect(useSettingsStore.getState().providersConfig.openai?.apiKey).not.toBe(ANCIENT_KEY);
    expect(await kv.get('settings-storage', 'account')).toBeNull();
  });

  it('leaves the pre-persist keys in place for their other readers', async () => {
    // `lib/ai/providers.ts:getProviderConfig` still reads `providersConfig` for
    // custom providers, so unlike the persist blob it is not purged.
    localStorageStub.setItem('llmModel', 'openai:gpt-4o');
    localStorageStub.setItem('providersConfig', JSON.stringify({ openai: {} }));

    const { useSettingsStore } = await import('@/lib/store/settings');
    await useSettingsStore.persist.rehydrate();

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

  it('ignores an existing raw blob and purges it, rather than migrating it', async () => {
    localStorageStub.setItem(
      'user-profile-storage',
      JSON.stringify({ state: { nickname: 'Ada', bio: 'hi', avatar: '/avatars/user.png' } }),
    );

    const { useUserProfileStore } = await import('@/lib/store/user-profile');
    await useUserProfileStore.persist.rehydrate();

    expect(useUserProfileStore.getState().nickname).toBe('');
    expect(localStorageStub.getItem('user-profile-storage')).toBeNull();
    expect(await kv.get('user-profile-storage', 'account')).toBeNull();
  });
});
