import { afterEach, expect, test, vi } from 'vitest';
import { contentHashOf, type ContentHash } from '../src/asset/blob.js';

afterEach(() => {
  vi.doUnmock('@aws-sdk/client-s3');
  vi.resetModules();
});

async function hashFor(value: string): Promise<ContentHash> {
  return (await contentHashOf(new Blob([value]))).contentHash;
}

/**
 * How long "the SDK was not resolved" is given to be disproved.
 *
 * This assertion is a negative, so it needs a window rather than a tick:
 * checking the counter on the same turn as the constructor proves nothing,
 * because a constructor that fires `import()` and drops the promise also reads
 * zero there. A module resolution that has been started completes in a few
 * milliseconds, so a resolution still absent after this window was never
 * started.
 */
const RESOLUTION_WINDOW_MS = 250;

function quietFor(signal: Promise<'resolved'>): Promise<'resolved' | 'quiet'> {
  return Promise.race([
    signal,
    new Promise<'quiet'>((resolve) => setTimeout(() => resolve('quiet'), RESOLUTION_WINDOW_MS)),
  ]);
}

test('loading the S3 byte-store module does not resolve the optional AWS SDK', async () => {
  const sdkModuleResolved = vi.fn();
  vi.doMock('@aws-sdk/client-s3', () => {
    sdkModuleResolved();
    throw new Error('the SDK must stay unresolved until the loader is called');
  });

  await expect(import('../src/asset/s3-bytes.js')).resolves.toHaveProperty('S3AssetByteStore');
  expect(sdkModuleResolved).not.toHaveBeenCalled();
});

test('a { client, bucket } store resolves the SDK on first use, not at construction', async () => {
  let sdkResolutions = 0;
  let announceResolution!: () => void;
  const resolutionSignal = new Promise<'resolved'>((resolve) => {
    announceResolution = () => resolve('resolved');
  });
  vi.doMock('@aws-sdk/client-s3', () => {
    sdkResolutions += 1;
    announceResolution();
    return {
      S3Client: class {},
      PutObjectCommand: class {
        constructor(readonly input: unknown) {}
      },
      GetObjectCommand: class {
        constructor(readonly input: unknown) {}
      },
      DeleteObjectCommand: class {
        constructor(readonly input: unknown) {}
      },
    };
  });
  const { S3AssetByteStore } = await import('../src/asset/s3-bytes.js');

  const sent: unknown[] = [];
  const store = new S3AssetByteStore({
    client: {
      send: async (command: unknown) => {
        sent.push(command);
        return {};
      },
    },
    bucket: 'lazy-commands',
  });

  // Constructing the store must not reach the optional peer dependency: a
  // deployment that configures a bucket but never stores a byte never resolves it.
  await expect(quietFor(resolutionSignal)).resolves.toBe('quiet');
  expect(sdkResolutions).toBe(0);

  const hash = await hashFor('lazy commands');
  await store.write(hash, new TextEncoder().encode('lazy commands'));
  expect(sdkResolutions).toBe(1);

  // Cached: a second call reuses the resolved constructors.
  await store.delete(hash);
  expect(sdkResolutions).toBe(1);
  expect(sent).toHaveLength(2);
});

test('an unresolvable SDK fails the first call by naming the optional dependency', async () => {
  vi.doMock('@aws-sdk/client-s3', () => {
    throw new Error('Cannot find module');
  });
  const { S3AssetByteStore } = await import('../src/asset/s3-bytes.js');

  const send = vi.fn();
  const store = new S3AssetByteStore({ client: { send }, bucket: 'no-sdk' });
  const hash = await hashFor('no sdk');

  // Named, rather than an undefined-property crash or an opaque "write failed".
  for (const operation of [
    () => store.write(hash, new TextEncoder().encode('no sdk')),
    () => store.read(hash),
    () => store.delete(hash),
  ]) {
    await expect(operation()).rejects.toThrow(/@aws-sdk\/client-s3/);
  }
  expect(send).not.toHaveBeenCalled();
});
