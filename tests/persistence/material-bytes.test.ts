import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalMaterialByteStore, MaterialByteStoreError } from '@/lib/server/materials/bytes';
import {
  ownerMaterialObjectKey,
  sessionMaterialObjectKey,
  sessionMaterialObjectPrefix,
} from '@/lib/server/materials/object-keys';

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

  it('round-trips an anonymous owner through the canonical portable object key', async () => {
    const { store } = await storeFixture();
    const key = ownerMaterialObjectKey('anon:00000000-0000-4000-8000-000000000001', 'mat-1');

    await store.put(key, Buffer.from('anonymous owner bytes'), 'application/pdf');

    await expect(store.get(key)).resolves.toEqual(Buffer.from('anonymous owner bytes'));
    expect(key).not.toContain('anon:');
  });

  it('preserves the committed object when an atomic replacement stream fails', async () => {
    const { store } = await storeFixture();
    const key = ownerMaterialObjectKey('owner-a', 'mat-a');
    await store.put(key, Buffer.from('committed'));
    const failing = Readable.from(
      (async function* () {
        yield Buffer.from('replacement');
        throw new Error('stream interrupted');
      })(),
    );

    let failure: unknown;
    try {
      await store.put(key, failing);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: 'MaterialByteStoreError',
      code: 'MATERIAL_BYTE_WRITE_FAILED',
      message: 'material byte write failed',
    });
    expect((failure as MaterialByteStoreError).cause).toBeUndefined();
    expect(String(failure)).not.toContain('stream interrupted');
    expect(JSON.stringify(failure)).not.toContain('stream interrupted');
    await expect(store.get(key)).resolves.toEqual(Buffer.from('committed'));
  });

  it('closes filesystem diagnostics for every operation while preserving typed failures', async () => {
    const { root } = await storeFixture();
    const rootFile = join(root, 'private-student-root');
    await writeFile(rootFile, Buffer.from('not a directory'));
    const blockedStore = new LocalMaterialByteStore(rootFile);
    const key = 'materials/v1/sessions/ses_secret/mat_secret/raw.private';
    const deleteKey = 'materials/v1/sessions/ses_secret/mat_delete/raw.private';
    await mkdir(join(root, deleteKey), { recursive: true });
    await writeFile(join(root, deleteKey, 'child'), Buffer.from('keeps directory non-empty'));
    const normalStore = new LocalMaterialByteStore(root);
    const longPrefix = `materials/${Array.from({ length: 400 }, () => 'x'.repeat(100)).join('/')}/`;

    const operations: Array<{
      operation: () => Promise<unknown>;
      code: string;
      secret: string;
    }> = [
      {
        operation: () => blockedStore.put(key, Buffer.from('x')),
        code: 'MATERIAL_BYTE_WRITE_FAILED',
        secret: key,
      },
      {
        operation: () => blockedStore.get(key),
        code: 'ENOENT',
        secret: key,
      },
      {
        operation: () => normalStore.delete(deleteKey),
        code: 'MATERIAL_BYTE_DELETE_FAILED',
        secret: deleteKey,
      },
      {
        operation: () => normalStore.deletePrefix(longPrefix),
        code: 'MATERIAL_BYTE_DELETE_FAILED',
        secret: longPrefix,
      },
    ];

    for (const fixture of operations) {
      let failure: unknown;
      try {
        await fixture.operation();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(MaterialByteStoreError);
      expect(failure).toMatchObject({ code: fixture.code });
      expect(String(failure)).not.toContain(rootFile);
      expect(String(failure)).not.toContain(fixture.secret);
      expect(JSON.stringify(failure)).not.toContain(rootFile);
      expect(JSON.stringify(failure)).not.toContain(fixture.secret);
    }
  });

  it('reclaims backend-owned pending replacements with the recorded object key', async () => {
    const { root, store } = await storeFixture();
    const key = ownerMaterialObjectKey('owner-a', 'mat-a');
    await store.put(key, Buffer.from('committed'));
    const pendingPath = `${join(root, key)}.pending-crash`;
    await writeFile(pendingPath, Buffer.from('partial'));

    await store.delete(key);

    await expect(store.get(key)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects the legacy colon-containing owner key for new writes', async () => {
    const { store } = await storeFixture();

    await expect(
      store.put('materials/anon:00000000-0000-4000-8000-000000000001/mat-1', Buffer.from('x')),
    ).rejects.toThrow('invalid material object key');
  });

  it('removes every object in one safe session prefix without touching another', async () => {
    const { store } = await storeFixture();
    const first = sessionMaterialObjectKey('session-a', 'mat-a', 'raw.bin');
    const orphan = sessionMaterialObjectKey('session-a', 'mat-orphan', 'text.md');
    const other = sessionMaterialObjectKey('session-b', 'mat-b', 'raw.bin');
    await store.put(first, Buffer.from('first'));
    await store.put(orphan, Buffer.from('orphan'));
    await store.put(other, Buffer.from('other'));

    await store.deletePrefix(sessionMaterialObjectPrefix('session-a'));

    await expect(store.get(first)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.get(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.get(other)).resolves.toEqual(Buffer.from('other'));
  });

  it('rejects path traversal for every operation', async () => {
    const { store } = await storeFixture();
    const secretKey = '../C:\\private\\student\\paper.pdf';

    await expect(store.put(secretKey, Buffer.from('x'))).rejects.toMatchObject({
      code: 'MATERIAL_BYTE_INVALID_KEY',
      message: 'invalid material object key',
    });
    await expect(store.put(secretKey, Buffer.from('x'))).rejects.not.toThrow(secretKey);
    await expect(store.get('../outside')).rejects.toThrow('invalid material object key');
    await expect(store.delete('../outside')).rejects.toThrow('invalid material object key');
    await expect(store.deletePrefix('../')).rejects.toThrow('invalid material object key');
  });
});
