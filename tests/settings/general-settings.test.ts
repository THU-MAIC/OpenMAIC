import { describe, expect, it, vi } from 'vitest';

import { runClearCache } from '@/components/settings/clear-cache-workflow';
import { clearLocalStorageKeepingImportState } from '@/lib/device-storage/clear-local-cache';
import enUS from '@/lib/i18n/locales/en-US.json';

/** A Map-backed `Storage` with the enumeration the clear walks. */
function mapStorage(storage: Map<string, string>): Storage {
  return {
    get length() {
      return storage.size;
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
  };
}

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

  it('keeps the pre-server learner key, the import ledger, model settings waiting for import and, while the import is pending, the pre-runtime quiz keys', () => {
    const storage = new Map<string, string>([
      ['maic:device:runtime.learnerKey', '"anon:legacy-device"'],
      ['maic:device:playback-cursor:stage-1', '{}'],
      ['maic:legacy-import:v3', '{"version":3}'],
      ['maic:legacy-import:model-settings', '{"slots":{}}'],
      ['maic:legacy-import:v1:anon:owner-a', '{"version":1}'],
      ['settings-storage', '{}'],
      ['quizDraft:scene-1', '{}'],
      ['quizAnswers:scene-1', '{}'],
      ['quizResults:scene-1', '[]'],
      ['quizAttemptId:scene-1', 'attempt-1'],
    ]);

    clearLocalStorageKeepingImportState(mapStorage(storage));

    expect([...storage.entries()]).toEqual([
      ['maic:device:runtime.learnerKey', '"anon:legacy-device"'],
      ['maic:legacy-import:v3', '{"version":3}'],
      ['maic:legacy-import:model-settings', '{"slots":{}}'],
      ['quizDraft:scene-1', '{}'],
      ['quizAnswers:scene-1', '{}'],
      ['quizResults:scene-1', '[]'],
      ['quizAttemptId:scene-1', 'attempt-1'],
    ]);
  });

  it('deletes the pre-runtime quiz keys once the ledger records the import as complete', () => {
    const ledger = JSON.stringify({
      version: 3,
      browserId: '0123456789abcdef0123456789abcdef',
      failedRuns: 0,
      completedAt: 1,
      courses: {},
      folders: {},
    });
    const storage = new Map<string, string>([
      ['maic:legacy-import:v3', ledger],
      ['quizDraft:scene-1', '{}'],
      ['quizAttemptId:scene-1', 'attempt-1'],
    ]);

    clearLocalStorageKeepingImportState(mapStorage(storage));

    expect([...storage.entries()]).toEqual([['maic:legacy-import:v3', ledger]]);
  });

  it('clears everything when there is no pre-server learner key', () => {
    const storage = new Map<string, string>([['settings-storage', '{}']]);

    clearLocalStorageKeepingImportState(mapStorage(storage));

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
