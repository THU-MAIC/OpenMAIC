import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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

  it('writes through a temporary file, leaving no partial object when the body fails', async () => {
    const { root, store } = await storeFixture();
    const key = 'materials/owner-1/mat-1.extraction/attempt.json';
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        controller.error(new Error('body broke'));
      },
    });
    await expect(store.put(key, failing)).rejects.toThrow('body broke');
    await expect(store.get(key)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(join(root, 'materials/owner-1/mat-1.extraction'))).resolves.toEqual([]);
  });

  it('deletes every object under a prefix, and only those', async () => {
    const { store } = await storeFixture();
    await store.put('materials/o/m1', Buffer.from('bytes'));
    await store.put('materials/o/m1.extraction/a.json', Buffer.from('a'));
    await store.put('materials/o/m1.extraction/b.json', Buffer.from('b'));
    await store.put('materials/o/m10.extraction/c.json', Buffer.from('c'));
    await store.deletePrefix('materials/o/m1.extraction/');
    await expect(store.get('materials/o/m1.extraction/a.json')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(store.get('materials/o/m1')).resolves.toEqual(Buffer.from('bytes'));
    await expect(store.get('materials/o/m10.extraction/c.json')).resolves.toEqual(Buffer.from('c'));
    // Absent is fine; a prefix that is not a folder is refused.
    await store.deletePrefix('materials/o/none.extraction/');
    await expect(store.deletePrefix('materials/o/m1')).rejects.toThrow(
      'invalid material object prefix',
    );
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
