import { describe, expect, test } from 'vitest';
import { ObjectUrlCache } from '../src/asset/blob.js';
import { objectUrlCount } from './setup.js';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function entriesOf(
  cache: ObjectUrlCache<string>,
): Map<string, { promise: Promise<{ identity: string; url: string } | null> }> {
  return (
    cache as unknown as {
      entries: Map<string, { promise: Promise<{ identity: string; url: string } | null> }>;
    }
  ).entries;
}

describe('ObjectUrlCache lifecycle', () => {
  test.each([0, 1, 2, 3])(
    'close revokes a retired mint across microtask depth %i',
    async (depth) => {
      const cache = new ObjectUrlCache<string>((left, right) => left === right);
      const mint = deferred();
      const resolving = cache.resolve('asset', 'version', async () => {
        await mint.promise;
        return {
          identity: 'version',
          url: URL.createObjectURL(new Blob(['snapshot'])),
        };
      });
      const entry = entriesOf(cache).get('asset');
      if (!entry) throw new Error('expected an in-flight cache entry');

      // Register shutdown before retirement adds its own promise reaction. At
      // depth zero, close starts after the entry records its settled value but
      // before the retired wrapper records the URL. The zero-hop path must stay
      // await-free: any extra await before close() defangs that regression case.
      const closing = entry.promise.then(async () => {
        for (let hop = 0; hop < depth; hop += 1) await Promise.resolve();
        await cache.close();
      });
      await cache.invalidate('asset');
      mint.resolve();

      await Promise.all([resolving, closing]);
      expect(objectUrlCount()).toBe(0);
    },
  );

  test('close revokes several pending generations after two microtask hops', async () => {
    const cache = new ObjectUrlCache<string>((left, right) => left === right);
    const mints = [deferred(), deferred(), deferred(), deferred()];
    const resolving = mints.map((mint, generation) =>
      cache.resolve('asset', `version-${generation}`, async () => {
        await mint.promise;
        return {
          identity: `version-${generation}`,
          url: URL.createObjectURL(new Blob([String(generation)])),
        };
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    const closing = cache.close();
    for (const mint of mints) mint.resolve();

    await Promise.all([...resolving, closing]);
    expect(objectUrlCount()).toBe(0);
  });

  test('resolve after close never repopulates cache entries', async () => {
    const cache = new ObjectUrlCache<string>((left, right) => left === right);
    await cache.close();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await cache.resolve('asset', `version-${attempt}`, async () => ({
        identity: `version-${attempt}`,
        url: URL.createObjectURL(new Blob([String(attempt)])),
      }));
    }

    expect(entriesOf(cache).size).toBe(0);
    expect(objectUrlCount()).toBe(0);
  });
});
