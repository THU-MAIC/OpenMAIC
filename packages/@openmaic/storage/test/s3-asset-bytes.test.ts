import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, test } from 'vitest';
import { contentHashOf } from '../src/asset/blob.js';
import { S3AssetByteStore } from '../src/asset/s3-bytes.js';
import { expectNoDigestSubstring } from './asset-contract.js';
import { runAssetByteStoreContract } from './asset-byte-store-contract.js';

class MemoryS3Client {
  readonly objects = new Map<string, Uint8Array>();

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const body = command.input.Body;
      if (!(body instanceof Uint8Array)) throw new Error('expected byte body');
      this.objects.set(command.input.Key!, new Uint8Array(body));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const bytes = this.objects.get(command.input.Key!);
      if (!bytes) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return {
        Body: {
          transformToByteArray: async () => new Uint8Array(bytes),
        },
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(command.input.Key!);
      return {};
    }
    throw new Error('unsupported command');
  }
}

function makeStore(client = new MemoryS3Client()): S3AssetByteStore {
  return new S3AssetByteStore({
    client: client as never,
    bucket: 'asset-contract',
  });
}

runAssetByteStoreContract('S3 bytes (in-memory SDK double)', () => makeStore());

describe('S3AssetByteStore commands and failures', () => {
  test('uses the content hash as the complete object key', async () => {
    const client = new MemoryS3Client();
    const store = makeStore(client);
    const data = new Blob(['keyed bytes']);
    const { contentHash, bytes } = await contentHashOf(data);
    await store.write(contentHash, new Uint8Array(bytes));
    expect([...client.objects.keys()]).toEqual([contentHash]);
  });

  test('maps not-found reads to null', async () => {
    const store = makeStore();
    const { contentHash } = await contentHashOf(new Blob(['absent']));
    await expect(store.read(contentHash)).resolves.toBeNull();
  });

  test('a bucket-level 404 is a failure, not an absent object', async () => {
    // NoSuchBucket, a misdirected endpoint, and a revoked access point all
    // answer 404 while the bytes still exist. Reporting one as a miss would
    // have the registry answer ASSET_NOT_FOUND for a live entry, and a caller
    // that clears its reference on that turns an outage into data loss.
    const failing = {
      async send(): Promise<never> {
        throw Object.assign(new Error('bucket is gone'), {
          name: 'NoSuchBucket',
          $metadata: { httpStatusCode: 404 },
        });
      },
    };
    const store = makeStore(failing as never);
    const { contentHash } = await contentHashOf(new Blob(['still here']));

    await expect(store.read(contentHash)).rejects.toThrow(/S3 asset byte read failed/);
  });

  test('sanitizes SDK failures so the digest cannot escape', async () => {
    const data = new Blob(['secret failure bytes']);
    const { contentHash, bytes } = await contentHashOf(data);
    const failing = {
      send: async () => {
        throw new Error(contentHash);
      },
    };
    const store = new S3AssetByteStore({ client: failing as never, bucket: 'failure' });

    for (const operation of [
      () => store.write(contentHash, new Uint8Array(bytes)),
      () => store.read(contentHash),
      () => store.delete(contentHash),
    ]) {
      let thrown: unknown;
      try {
        await operation();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      await expectNoDigestSubstring(String(thrown), data);
    }
  });
});
