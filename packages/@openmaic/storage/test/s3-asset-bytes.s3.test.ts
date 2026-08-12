import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { contentHashOf, type ContentHash } from '../src/asset/blob.js';
import { S3AssetByteStore } from '../src/asset/s3-bytes.js';

const endpoint = process.env.S3_CONTRACT_ENDPOINT;
const bucket = process.env.S3_CONTRACT_BUCKET;
const configured = Boolean(endpoint && bucket);

if (process.env.STORAGE_S3_CONTRACT_REQUIRED === '1' && !configured) {
  throw new Error(
    '@openmaic/storage: STORAGE_S3_CONTRACT_REQUIRED=1 requires S3_CONTRACT_ENDPOINT and S3_CONTRACT_BUCKET; refusing to skip the S3 asset suite',
  );
}

describe.skipIf(!configured)('S3AssetByteStore with an S3-compatible server', () => {
  let client: S3Client;
  let store: S3AssetByteStore;
  const written = new Set<ContentHash>();

  beforeAll(async () => {
    client = new S3Client({
      endpoint,
      forcePathStyle: true,
      region: process.env.S3_CONTRACT_REGION ?? 'us-east-1',
      credentials:
        process.env.S3_CONTRACT_ACCESS_KEY && process.env.S3_CONTRACT_SECRET_KEY
          ? {
              accessKeyId: process.env.S3_CONTRACT_ACCESS_KEY,
              secretAccessKey: process.env.S3_CONTRACT_SECRET_KEY,
            }
          : undefined,
    });
    await client.send(new HeadBucketCommand({ Bucket: bucket! }));
    store = new S3AssetByteStore({
      client: client as never,
      commands: {
        put: (input) => new PutObjectCommand(input),
        get: (input) => new GetObjectCommand(input),
        delete: (input) => new DeleteObjectCommand(input),
      },
      bucket: bucket!,
    });
  });

  afterAll(async () => {
    await Promise.all([...written].map((hash) => store.delete(hash)));
    client.destroy();
  });

  test('round-trips and deletes an object against real S3 semantics', async () => {
    const data = new Blob([`s3-real-${crypto.randomUUID()}`]);
    const { contentHash, bytes } = await contentHashOf(data);
    written.add(contentHash);
    await store.write(contentHash, new Uint8Array(bytes));
    expect(await store.read(contentHash)).toEqual(new Uint8Array(bytes));
    await store.delete(contentHash);
    written.delete(contentHash);
    expect(await store.read(contentHash)).toBeNull();
  });

  test('plain PUT is idempotent for an existing hash-named key', async () => {
    const data = new Blob([`s3-idempotent-${crypto.randomUUID()}`]);
    const { contentHash, bytes } = await contentHashOf(data);
    written.add(contentHash);
    await store.write(contentHash, new Uint8Array(bytes));
    await expect(store.write(contentHash, new Uint8Array(bytes))).resolves.toBeUndefined();
    expect(await store.read(contentHash)).toEqual(new Uint8Array(bytes));
  });

  test('missing reads and repeated deletes are idempotent', async () => {
    const { contentHash } = await contentHashOf(new Blob([`s3-missing-${crypto.randomUUID()}`]));
    expect(await store.read(contentHash)).toBeNull();
    await expect(store.delete(contentHash)).resolves.toBeUndefined();
    await expect(store.delete(contentHash)).resolves.toBeUndefined();
  });
});
