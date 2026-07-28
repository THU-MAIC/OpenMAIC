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
