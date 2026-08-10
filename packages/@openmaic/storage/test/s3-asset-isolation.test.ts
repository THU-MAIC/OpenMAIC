import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@aws-sdk/client-s3');
  vi.resetModules();
});

test('loading the S3 byte-store module does not resolve the optional AWS SDK', async () => {
  const sdkModuleResolved = vi.fn();
  vi.doMock('@aws-sdk/client-s3', () => {
    sdkModuleResolved();
    throw new Error('the SDK must stay unresolved until the loader is called');
  });

  await expect(import('../src/asset/s3-bytes.js')).resolves.toHaveProperty('S3AssetByteStore');
  expect(sdkModuleResolved).not.toHaveBeenCalled();
});
