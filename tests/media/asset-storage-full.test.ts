/**
 * The "this store had no room" marker is device metadata, and it is
 * best-effort.
 *
 * It is awaited by a generation pass that has already enqueued its tasks, so a
 * rejected promise here does not degrade to "generate anyway": it terminates
 * the pass and leaves every task pending, with no affordance left to recover
 * them. A browser that cannot keep this note must therefore behave exactly as
 * it did before the note existed.
 *
 * The hostile case is a browser whose storage is denied by policy. There,
 * reading the `localStorage` property throws `SecurityError` — `typeof`
 * included, because the throw is in the property's getter and not in anything
 * the operand's type could avoid. An availability check written outside the
 * guarded block is the one line that can turn this into a rejection.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearAssetStorageFull,
  isAssetStorageFull,
  markAssetStorageFull,
  setAssetStorageFullStoreForTests,
} from '@/lib/media/asset-storage-full';

const stageId = 'kv-stage';

/** Install a `localStorage` whose every access throws, and take it back. */
function denyStorageAccess(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  };
}

describe('the asset storage-full marker', () => {
  afterEach(() => {
    setAssetStorageFullStoreForTests(undefined);
  });

  it('answers "not full" and stays silent when storage access throws', async () => {
    // No override: the module has to resolve its own store, which is where the
    // property access happens.
    setAssetStorageFullStoreForTests(undefined);
    const restore = denyStorageAccess();
    try {
      await expect(isAssetStorageFull(stageId)).resolves.toBe(false);
      await expect(markAssetStorageFull(stageId)).resolves.toBeUndefined();
      await expect(clearAssetStorageFull(stageId)).resolves.toBeUndefined();
      // Still "not full" after a mark that had nowhere to go: the caller gets
      // the behaviour that predates the marker, not a half-remembered one.
      await expect(isAssetStorageFull(stageId)).resolves.toBe(false);
    } finally {
      restore();
    }
  });

  it('answers "not full" where there is no storage at all', async () => {
    setAssetStorageFullStoreForTests(undefined);
    await expect(isAssetStorageFull(stageId)).resolves.toBe(false);
    await expect(markAssetStorageFull(stageId)).resolves.toBeUndefined();
  });

  it('remembers the condition per course when there is somewhere to keep it', async () => {
    const entries = new Map<string, unknown>();
    setAssetStorageFullStoreForTests({
      get: async <T>(key: string) => (entries.get(key) as T) ?? null,
      set: async (key: string, value: unknown) => {
        entries.set(key, value);
      },
      remove: async (key: string) => {
        entries.delete(key);
      },
      keys: async (prefix = '') => [...entries.keys()].filter((key) => key.startsWith(prefix)),
    });

    await markAssetStorageFull(stageId);

    await expect(isAssetStorageFull(stageId)).resolves.toBe(true);
    // One namespace per course: a full store stops the course that met it,
    // not every course this browser has open.
    await expect(isAssetStorageFull('another-course')).resolves.toBe(false);

    await clearAssetStorageFull(stageId);
    await expect(isAssetStorageFull(stageId)).resolves.toBe(false);
  });

  it('survives a store that rejects every operation', async () => {
    const rejects = async (): Promise<never> => {
      throw new Error('device storage unavailable');
    };
    setAssetStorageFullStoreForTests({
      get: rejects,
      set: rejects,
      remove: rejects,
      keys: rejects,
    });

    await expect(markAssetStorageFull(stageId)).resolves.toBeUndefined();
    await expect(isAssetStorageFull(stageId)).resolves.toBe(false);
    await expect(clearAssetStorageFull(stageId)).resolves.toBeUndefined();
  });
});
