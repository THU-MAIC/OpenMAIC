import { describe, expect, it, vi } from 'vitest';

import { runClearCache } from '@/components/settings/clear-cache-workflow';
import { clearLocalStorageKeepingImportState } from '@/lib/device-storage/clear-local-cache';
import enUS from '@/lib/i18n/locales/en-US.json';

describe('general settings: clear local cache', () => {
  it('clears the device cache, then storage, then the persisted stores', async () => {
    const order: string[] = [];
    await runClearCache({
      clearLocalCache: vi.fn(async () => {
        order.push('local cache');
      }),
      clearLocalStorage: () => order.push('localStorage'),
      clearSessionStorage: () => order.push('sessionStorage'),
      clearPersistedStores: vi.fn(async () => {
        order.push('persisted stores');
      }),
    });

    expect(order).toEqual(['local cache', 'localStorage', 'sessionStorage', 'persisted stores']);
  });

  it('stops subsequent cleanup when the device cache cannot be cleared', async () => {
    const clearLocalStorage = vi.fn();
    const clearSessionStorage = vi.fn();
    const clearPersistedStores = vi.fn().mockResolvedValue(undefined);

    await expect(
      runClearCache({
        clearLocalCache: vi.fn().mockRejectedValue(new Error('hard failure')),
        clearLocalStorage,
        clearSessionStorage,
        clearPersistedStores,
      }),
    ).rejects.toThrow('hard failure');
    expect(clearLocalStorage).not.toHaveBeenCalled();
    expect(clearSessionStorage).not.toHaveBeenCalled();
    expect(clearPersistedStores).not.toHaveBeenCalled();
  });

  it('keeps the pre-server learner key the importer needs, and nothing else', () => {
    const storage = new Map<string, string>([
      ['maic:device:runtime.learnerKey', '"anon:legacy-device"'],
      ['maic:device:playback-cursor:stage-1', '{}'],
      ['settings-storage', '{}'],
    ]);
    const fake = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      clear: () => storage.clear(),
    } as unknown as Storage;

    clearLocalStorageKeepingImportState(fake);

    expect([...storage.entries()]).toEqual([
      ['maic:device:runtime.learnerKey', '"anon:legacy-device"'],
    ]);
  });

  it('clears everything when there is no pre-server learner key', () => {
    const storage = new Map<string, string>([['settings-storage', '{}']]);
    const fake = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      clear: () => storage.clear(),
    } as unknown as Storage;

    clearLocalStorageKeepingImportState(fake);

    expect(storage.size).toBe(0);
  });

  it('does not tell the user that clearing deletes their classrooms', () => {
    // Courses and chat history are server data; clearing this browser's cache
    // leaves them in place.
    expect(enUS.settings.clearCacheDescription).toMatch(
      /stored on the server and are not affected/,
    );
    expect(enUS.settings.clearCacheConfirmItems).not.toMatch(/Classrooms|Chat history/);
  });
});
