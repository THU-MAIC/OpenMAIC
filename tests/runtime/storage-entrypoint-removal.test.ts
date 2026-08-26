import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const STORAGE_DIR = fileURLToPath(new URL('../../lib/storage/', import.meta.url));

describe('lib/storage entry points', () => {
  it('removes the obsolete no-op storage provider abstraction', () => {
    // `getStorageProvider()` unconditionally returned a NoopStorageProvider and
    // swallowed every operation into silence, with no real caller anywhere in
    // the repo. The obsolete abstraction (entry point, type file, no-op
    // provider) is deleted; re-adding any of it fails this pin.
    expect(existsSync(`${STORAGE_DIR}index.ts`)).toBe(false);
    expect(existsSync(`${STORAGE_DIR}types.ts`)).toBe(false);
    expect(existsSync(`${STORAGE_DIR}providers/noop.ts`)).toBe(false);
  });

  it('refuses the deleted public entry point instead of silently no-opping', async () => {
    // A caller that used to believe it had storage now gets a loud resolution
    // failure at import time — never a silent no-op provider. The specifier is
    // deliberately not a literal so type-checking does not re-require the
    // deleted module.
    const deletedEntryPoint: string = '@/lib/storage';
    await expect(import(deletedEntryPoint)).rejects.toThrow();
  });

  it('keeps the real storage client upload helper for its existing caller', async () => {
    // `lib/storage/client.ts` has a live caller (PBL v2 submission uploads);
    // only the dead abstraction was removed.
    const { uploadBlobToStorage } = await import('@/lib/storage/client');
    expect(typeof uploadBlobToStorage).toBe('function');
  });
});
