import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, test } from 'vitest';
import { contentHashOf } from '../src/asset/blob.js';
import { S3AssetByteStore } from '../src/asset/s3-bytes.js';
import { expectNoDigestSubstring } from './asset-contract.js';
import { runAssetByteStoreContract } from './asset-byte-store-contract.js';

const commands = {
  put: (input: ConstructorParameters<typeof PutObjectCommand>[0]) => new PutObjectCommand(input),
  get: (input: ConstructorParameters<typeof GetObjectCommand>[0]) => new GetObjectCommand(input),
  delete: (input: ConstructorParameters<typeof DeleteObjectCommand>[0]) =>
    new DeleteObjectCommand(input),
};

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
    commands,
    bucket: 'asset-contract',
  });
}

/**
 * The construction shape that omits `commands` entirely — what a host holding
 * only a client and a bucket writes, and what this store accepted before
 * `commands` existed. The constructors then come from the installed SDK, which
 * is the same module the client double matches its commands against.
 */
function makeLazyStore(client = new MemoryS3Client()): S3AssetByteStore {
  return new S3AssetByteStore({
    client: client as never,
    bucket: 'asset-contract-lazy',
  });
}

runAssetByteStoreContract('S3 bytes (in-memory SDK double)', () => makeStore());
runAssetByteStoreContract('S3 bytes (commands resolved from the SDK)', () => makeLazyStore());

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
    const store = new S3AssetByteStore({ client: failing as never, commands, bucket: 'failure' });

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

describe('S3AssetByteStore URL signing', () => {
  const headers = {
    contentType: 'image/png',
    contentDisposition: 'attachment',
    cacheControl: 'private, no-store',
    expiresInSeconds: 60,
  };

  test('signs a GET that pins the contract response headers', async () => {
    const signed: Array<{ command: unknown; expiresInSeconds: number }> = [];
    const store = new S3AssetByteStore({
      client: new MemoryS3Client() as never,
      commands,
      signer: {
        sign: async (_client, command, expiresInSeconds) => {
          signed.push({ command, expiresInSeconds });
          return 'https://objects.example/signed-url';
        },
      },
      bucket: 'asset-signing',
    });
    const { contentHash } = await contentHashOf(new Blob(['signed bytes']));

    const url = await store.signReadUrl(contentHash, headers);

    expect(url).toBe('https://objects.example/signed-url');
    expect(signed).toHaveLength(1);
    const command = signed[0]!.command;
    expect(command).toBeInstanceOf(GetObjectCommand);
    const input = (command as GetObjectCommand).input;
    // The object key is the content hash, and the served media type,
    // disposition, and cache posture travel inside the signature.
    expect(input).toMatchObject({
      Bucket: 'asset-signing',
      Key: contentHash,
      ResponseContentType: 'image/png',
      ResponseContentDisposition: 'attachment',
      ResponseCacheControl: 'private, no-store',
    });
    expect(signed[0]!.expiresInSeconds).toBe(60);
  });

  test('omits the disposition override for an inline-served type', async () => {
    let input: unknown;
    const store = new S3AssetByteStore({
      client: new MemoryS3Client() as never,
      commands,
      signer: {
        sign: async (_client, command) => {
          input = (command as GetObjectCommand).input;
          return 'https://objects.example/signed-url';
        },
      },
      bucket: 'asset-signing',
    });
    const { contentHash } = await contentHashOf(new Blob(['inline bytes']));

    await store.signReadUrl(contentHash, {
      contentType: 'image/png',
      cacheControl: 'private, no-store',
      expiresInSeconds: 30,
    });

    expect(input).toMatchObject({ ResponseContentType: 'image/png' });
    expect(input).not.toHaveProperty('ResponseContentDisposition');
  });

  test('sanitizes signing failures so the digest cannot escape', async () => {
    const data = new Blob(['secret signing bytes']);
    const { contentHash } = await contentHashOf(data);
    const store = new S3AssetByteStore({
      client: new MemoryS3Client() as never,
      commands,
      signer: {
        sign: async () => {
          throw new Error(contentHash);
        },
      },
      bucket: 'signing-failure',
    });

    let thrown: unknown;
    try {
      await store.signReadUrl(contentHash, headers);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toMatch(/S3 asset byte sign failed/);
    await expectNoDigestSubstring(String(thrown), data);
  });

  test('resolves the SDK and presigner lazily for a { client, bucket } store', async () => {
    // Both optional peers installed, neither supplied: the store resolves them
    // on its own. Presigning is local credential arithmetic, so a client with
    // static credentials signs without any network access.
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const store = new S3AssetByteStore({ client: client as never, bucket: 'lazy-signing' });
    const { contentHash } = await contentHashOf(new Blob(['lazy signed bytes']));

    const url = await store.signReadUrl(contentHash, {
      contentType: 'image/png',
      contentDisposition: 'attachment',
      cacheControl: 'private, no-store',
      expiresInSeconds: 60,
    });
    expect(url).toBeDefined();

    const signed = new URL(url!);
    expect(signed.hostname).toBe('lazy-signing.s3.us-east-1.amazonaws.com');
    expect(signed.pathname).toBe(`/${contentHash}`);
    expect(signed.searchParams.get('response-content-type')).toBe('image/png');
    expect(signed.searchParams.get('response-content-disposition')).toBe('attachment');
    expect(signed.searchParams.get('response-cache-control')).toBe('private, no-store');
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(signed.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });
});
