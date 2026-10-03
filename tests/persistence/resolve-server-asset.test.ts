import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetNotFoundError, toAssetId } from '@openmaic/storage';

import { resolveOwnedAsset } from '@/lib/persistence/resolve-server-asset';

// Mock only the storage provider seam; the module under test stays real, so
// the principal is derived from the owner by the actual implementation.
const mocks = vi.hoisted(() => ({
  getServerPersistenceProvider: vi.fn(),
  assetStoreIdentify: vi.fn(),
  assetStoreResolve: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));

const ASSET_ID = 'ast_unit_test';
const RESOLVED_BYTES = Buffer.from('resolved course material bytes');
const RESOLVED_MIME = 'text/plain';
const RESOLVED_BYTE_LENGTH = RESOLVED_BYTES.length;
const SIZE_CAP = 1024 * 1024;

const OWNER_ID = 'anon:33333333-3333-4333-8333-333333333333';
const OWNER_PRINCIPAL = { key: `owner:${OWNER_ID}`, learnerKey: OWNER_ID };

function resolve(maxByteLength?: number) {
  return resolveOwnedAsset(ASSET_ID, OWNER_ID, 'postgres://test', maxByteLength);
}

describe('resolveOwnedAsset', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    mocks.getServerPersistenceProvider.mockReset();
    mocks.assetStoreIdentify.mockReset();
    mocks.assetStoreResolve.mockReset();
    mocks.poolQuery.mockReset();
    // The foreign-read lookup finds nothing unless a case says otherwise.
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    mocks.getServerPersistenceProvider.mockResolvedValue({
      pool: { query: mocks.poolQuery },
      assetStore: {
        identify: mocks.assetStoreIdentify,
        resolve: mocks.assetStoreResolve,
      },
    });
    mocks.assetStoreIdentify.mockResolvedValue({
      mime: RESOLVED_MIME,
      revision: 1,
      byteLength: RESOLVED_BYTE_LENGTH,
    });
  });

  it('derives the owner asset principal from the owner and resolves the asset', async () => {
    mocks.assetStoreResolve.mockResolvedValue({ bytes: RESOLVED_BYTES, mime: RESOLVED_MIME });

    const resolution = await resolve(SIZE_CAP);

    expect(resolution).toEqual({
      status: 'resolved',
      buffer: RESOLVED_BYTES,
      mimeType: RESOLVED_MIME,
    });
    expect(mocks.getServerPersistenceProvider).toHaveBeenCalledWith('postgres://test');
    // The owner's own partition answers first; no foreign lookup is needed.
    expect(mocks.assetStoreIdentify).toHaveBeenCalledWith(OWNER_PRINCIPAL, toAssetId(ASSET_ID));
    expect(mocks.assetStoreResolve).toHaveBeenCalledWith(OWNER_PRINCIPAL, toAssetId(ASSET_ID));
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('reads another owner’s entry only under the rule the persistence route applies', async () => {
    const foreign = { key: 'owner:user:someone-else' };
    mocks.assetStoreResolve.mockImplementation(async (principal: { key: string }) =>
      principal.key === foreign.key ? { bytes: RESOLVED_BYTES, mime: RESOLVED_MIME } : null,
    );
    mocks.poolQuery.mockResolvedValue({ rows: [{ principal: foreign.key }] });

    const resolution = await resolve();

    expect(resolution.status).toBe('resolved');
    expect(mocks.assetStoreResolve).toHaveBeenLastCalledWith(foreign, toAssetId(ASSET_ID));
    expect(mocks.poolQuery.mock.calls[0]?.[1]).toEqual([
      ASSET_ID,
      OWNER_PRINCIPAL.key,
      'shared',
      'owner:',
    ]);
  });

  it('answers too_large from the recorded length WITHOUT resolving the bytes', async () => {
    mocks.assetStoreIdentify.mockResolvedValue({
      mime: RESOLVED_MIME,
      revision: 1,
      byteLength: 2 * SIZE_CAP,
    });

    const resolution = await resolve(SIZE_CAP);

    expect(resolution).toEqual({ status: 'too_large' });
    expect(mocks.assetStoreIdentify).toHaveBeenCalledTimes(1);
    // The whole point: the store is never asked to materialize the bytes.
    expect(mocks.assetStoreResolve).not.toHaveBeenCalled();
  });

  it('resolves an asset whose recorded length is within the caller-supplied cap', async () => {
    mocks.assetStoreIdentify.mockResolvedValue({
      mime: RESOLVED_MIME,
      revision: 1,
      byteLength: SIZE_CAP,
    });
    mocks.assetStoreResolve.mockResolvedValue({ bytes: RESOLVED_BYTES, mime: RESOLVED_MIME });

    const resolution = await resolve(SIZE_CAP);

    expect(resolution).toEqual({
      status: 'resolved',
      buffer: RESOLVED_BYTES,
      mimeType: RESOLVED_MIME,
    });
    expect(mocks.assetStoreIdentify).toHaveBeenCalledTimes(1);
    expect(mocks.assetStoreResolve).toHaveBeenCalledTimes(1);
  });

  it('does not consult the store at all when no cap is supplied', async () => {
    mocks.assetStoreResolve.mockResolvedValue({ bytes: RESOLVED_BYTES, mime: RESOLVED_MIME });

    const resolution = await resolve();

    expect(resolution.status).toBe('resolved');
    expect(mocks.assetStoreIdentify).not.toHaveBeenCalled();
    expect(mocks.assetStoreResolve).toHaveBeenCalledTimes(1);
  });

  it('reports missing when the store resolves no entry for the id', async () => {
    mocks.assetStoreResolve.mockResolvedValue(undefined);

    const resolution = await resolve(SIZE_CAP);

    expect(resolution).toEqual({ status: 'missing' });
  });

  it('reports missing when the identity read finds no entry (resolve never called)', async () => {
    mocks.assetStoreIdentify.mockResolvedValue(null);

    const resolution = await resolve(SIZE_CAP);

    expect(resolution).toEqual({ status: 'missing' });
    expect(mocks.assetStoreIdentify).toHaveBeenCalledTimes(1);
    expect(mocks.assetStoreResolve).not.toHaveBeenCalled();
  });

  it('reports missing when the store raises AssetNotFoundError', async () => {
    mocks.assetStoreResolve.mockRejectedValue(new AssetNotFoundError());

    const resolution = await resolve();

    expect(resolution).toEqual({ status: 'missing' });
  });

  it('rethrows any other store failure', async () => {
    const failure = new Error('db connection refused');
    mocks.assetStoreResolve.mockRejectedValue(failure);

    await expect(resolve()).rejects.toBe(failure);
  });
});
