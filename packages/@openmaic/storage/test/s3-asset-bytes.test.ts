import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, test, vi } from 'vitest';
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

describe('isolated byte namespaces', () => {
  test('forwards cancellation to an isolated upload and exposes only a safe failure category', async () => {
    const controller = new AbortController();
    const send = vi.fn(
      (_command: unknown, options?: { abortSignal?: AbortSignal }) =>
        new Promise((_, reject) =>
          options?.abortSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('PRIVATE URL', 'AbortError')),
            { once: true },
          ),
        ),
    );
    const store = new S3AssetByteStore({
      bucket: 'test-bucket',
      client: { send },
      commands,
    }).withPrefix('checkpoints/');
    const { contentHash, bytes } = await contentHashOf(new Blob(['content']));
    const saving = store.write(contentHash, new Uint8Array(bytes), { signal: controller.signal });
    const rejected = expect(saving).rejects.toMatchObject({
      code: 'ASSET_STORAGE_TIMEOUT',
      message: '@openmaic/storage: S3 asset byte write failed',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[1]?.abortSignal).toBe(controller.signal);
    controller.abort();
    await rejected;
  });
  test.each([
    ['AccessDenied', 'ASSET_STORAGE_PERMISSION'],
    ['NoSuchBucket', 'ASSET_STORAGE_CONFIG'],
    ['RequestTimeout', 'ASSET_STORAGE_TIMEOUT'],
    ['UnknownError', 'ASSET_STORAGE_UNAVAILABLE'],
  ])('classifies %s without exposing SDK details', async (name, code) => {
    const store = new S3AssetByteStore({
      bucket: 'test-bucket',
      commands,
      client: {
        send: async () => {
          throw Object.assign(new Error('PRIVATE SECRET'), { name });
        },
      },
    });
    const { contentHash, bytes } = await contentHashOf(new Blob(['content']));
    await expect(store.write(contentHash, new Uint8Array(bytes))).rejects.toMatchObject({
      code,
      message: '@openmaic/storage: S3 asset byte write failed',
    });
  });
  test('keeps course and checkpoint bytes separate in both directions', async () => {
    const client = new MemoryS3Client();
    const course = makeStore(client);
    const checkpoint = course.withPrefix('sandbox-checkpoints/v1/one/');
    const { contentHash, bytes } = await contentHashOf(new Blob(['same content']));
    await course.write(contentHash, new Uint8Array(bytes));
    await checkpoint.write(contentHash, new Uint8Array(bytes));
    expect([...client.objects.keys()]).toEqual([
      contentHash,
      'sandbox-checkpoints/v1/one/' + contentHash,
    ]);
    await course.delete(contentHash);
    expect(await checkpoint.read(contentHash)).not.toBeNull();
    await course.write(contentHash, new Uint8Array(bytes));
    await checkpoint.delete(contentHash);
    expect(await course.read(contentHash)).not.toBeNull();
  });
  test.each(['', '../', '/root/', 'with.dot/', 'no-trailing-slash'])(
    'refuses unsafe namespace %j',
    (prefix) => {
      expect(() => makeStore().withPrefix(prefix)).toThrow();
    },
  );
});
