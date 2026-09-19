import { describe, expect, test } from 'vitest';
import type { AssetByteStore } from '../src/asset/byte-store.js';
import { contentHashOf, type ContentHash } from '../src/asset/blob.js';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

async function hashFor(value: string): Promise<ContentHash> {
  return (await contentHashOf(new Blob([value]))).contentHash;
}

export function runAssetByteStoreContract(
  name: string,
  makeStore: () => AssetByteStore,
  namespace = name,
): void {
  const value = (label: string): string => `${namespace}:${label}`;

  describe(`asset byte store contract: ${name}`, () => {
    test('write and read round-trip bytes', async () => {
      const store = makeStore();
      const payload = value('round trip');
      const hash = await hashFor(payload);
      await store.write(hash, bytes(payload));
      expect(await store.read(hash)).toEqual(bytes(payload));
    });

    test('writing the same bytes twice is idempotent', async () => {
      const store = makeStore();
      const payload = value('idempotent write');
      const hash = await hashFor(payload);
      await expect(store.write(hash, bytes(payload))).resolves.toBeUndefined();
      await expect(store.write(hash, bytes(payload))).resolves.toBeUndefined();
      expect(await store.read(hash)).toEqual(bytes(payload));
    });

    test('a missing hash reads as null', async () => {
      const store = makeStore();
      expect(await store.read(await hashFor(value('missing')))).toBeNull();
    });

    test('zero-byte values are legal', async () => {
      const store = makeStore();
      const hash = await hashFor('');
      await store.write(hash, new Uint8Array());
      expect(await store.read(hash)).toEqual(new Uint8Array());
    });

    test('delete removes bytes and is idempotent', async () => {
      const store = makeStore();
      const payload = value('delete');
      const hash = await hashFor(payload);
      await store.write(hash, bytes(payload));
      await expect(store.delete(hash)).resolves.toBeUndefined();
      expect(await store.read(hash)).toBeNull();
      await expect(store.delete(hash)).resolves.toBeUndefined();
    });
  });
}
