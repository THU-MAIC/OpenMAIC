import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalMaterialByteStore } from '@/lib/server/materials/bytes';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storeFixture(): Promise<{ root: string; store: LocalMaterialByteStore }> {
  const root = await mkdtemp(join(tmpdir(), 'openmaic-material-bytes-'));
  roots.push(root);
  return { root, store: new LocalMaterialByteStore(root) };
}

describe('LocalMaterialByteStore', () => {
  it('round-trips and deletes an object key under its root', async () => {
    const { root, store } = await storeFixture();
    const key = 'materials/owner-1/mat-1';

    await store.put(key, Buffer.from('material bytes'), 'application/pdf');

    await expect(store.get(key)).resolves.toEqual(Buffer.from('material bytes'));
    await expect(readFile(join(root, key))).resolves.toEqual(Buffer.from('material bytes'));
    await store.delete(key);
    await expect(store.get(key)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects path traversal for every operation', async () => {
    const { store } = await storeFixture();

    await expect(store.put('../outside', Buffer.from('x'))).rejects.toThrow(
      'invalid material object key',
    );
    await expect(store.get('../outside')).rejects.toThrow('invalid material object key');
    await expect(store.delete('../outside')).rejects.toThrow('invalid material object key');
  });
});
