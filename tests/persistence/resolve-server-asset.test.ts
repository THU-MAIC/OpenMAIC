import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetNotFoundError, toAssetId } from '@openmaic/storage';

import { resolveServerAsset } from '@/lib/persistence/resolve-server-asset';

// Mock only the storage provider seam; the module under test and the
// development authenticator stay real so principal derivation from headers is
// exercised against the actual implementation.
const mocks = vi.hoisted(() => ({
  getServerPersistenceProvider: vi.fn(),
  assetStoreIdentify: vi.fn(),
  assetStoreResolve: vi.fn(),
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));

const ASSET_ID = 'ast_unit_test';
const RESOLVED_BYTES = Buffer.from('resolved course material bytes');
const RESOLVED_MIME = 'text/plain';
const RESOLVED_BYTE_LENGTH = RESOLVED_BYTES.length;
const SIZE_CAP = 1024 * 1024;

function authHeaders(token?: string): Headers {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  return headers;
}

describe('resolveServerAsset', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'shared-secret');
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    mocks.getServerPersistenceProvider.mockReset();
    mocks.assetStoreIdentify.mockReset();
    mocks.assetStoreResolve.mockReset();
    mocks.getServerPersistenceProvider.mockResolvedValue({
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

  it('derives the shared principal from a valid bearer token and resolves the asset', async () => {
    mocks.assetStoreResolve.mockResolvedValue({ bytes: RESOLVED_BYTES, mime: RESOLVED_MIME });

    const resolution = await resolveServerAsset(ASSET_ID, authHeaders('shared-secret'), SIZE_CAP);

    expect(resolution).toEqual({
      status: 'resolved',
      buffer: RESOLVED_BYTES,
      mimeType: RESOLVED_MIME,
    });
    expect(mocks.getServerPersistenceProvider).toHaveBeenCalledWith('postgres://test');
    // The development authenticator maps every caller to the single shared
    // asset partition (see server-auth.ts), so the store is addressed by the
    // shared principal, not by any per-header partition.
    expect(mocks.assetStoreIdentify).toHaveBeenCalledWith({ key: 'shared' }, toAssetId(ASSET_ID));
    expect(mocks.assetStoreResolve).toHaveBeenCalledWith({ key: 'shared' }, toAssetId(ASSET_ID));
  });

  it('answers too_large from the recorded length WITHOUT resolving the bytes', async () => {
    mocks.assetStoreIdentify.mockResolvedValue({
      mime: RESOLVED_MIME,
      revision: 1,
      byteLength: 2 * SIZE_CAP,
    });

    const resolution = await resolveServerAsset(ASSET_ID, authHeaders('shared-secret'), SIZE_CAP);

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

    const resolution = await resolveServerAsset(ASSET_ID, authHeaders('shared-secret'), SIZE_CAP);

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

    const resolution = await resolveServerAsset(ASSET_ID, authHeaders('shared-secret'));

    expect(resolution.status).toBe('resolved');
    expect(mocks.assetStoreIdentify).not.toHaveBeenCalled();
    expect(mocks.assetStoreResolve).toHaveBeenCalledTimes(1);
  });

  it('reports unauthenticated when the bearer token is missing', async () => {
    const resolution = await resolveServerAsset(ASSET_ID, authHeaders());

    expect(resolution).toEqual({ status: 'unauthenticated' });
    expect(mocks.assetStoreResolve).not.toHaveBeenCalled();
  });

  it('reports unauthenticated when the bearer token is wrong', async () => {
    const resolution = await resolveServerAsset(ASSET_ID, authHeaders('wrong-token'));

    expect(resolution).toEqual({ status: 'unauthenticated' });
    expect(mocks.assetStoreResolve).not.toHaveBeenCalled();
  });

  it('reports unconfigured when DATABASE_URL is absent', async () => {
    vi.stubEnv('DATABASE_URL', '');

    const resolution = await resolveServerAsset(ASSET_ID, authHeaders('shared-secret'));

    expect(resolution).toEqual({ status: 'unconfigured' });
    expect(mocks.getServerPersistenceProvider).not.toHaveBeenCalled();
  });

  it('reports missing when the store resolves no entry for the id', async () => {
    mocks.assetStoreResolve.mockResolvedValue(undefined);

    const resolution = await resolveServerAsset(ASSET_ID, authHeaders('shared-secret'), SIZE_CAP);

    expect(resolution).toEqual({ status: 'missing' });
  });

  it('reports missing when the identity read finds no entry (resolve never called)', async () => {
    mocks.assetStoreIdentify.mockResolvedValue(null);

    const resolution = await resolveServerAsset(ASSET_ID, authHeaders('shared-secret'), SIZE_CAP);

    expect(resolution).toEqual({ status: 'missing' });
    expect(mocks.assetStoreIdentify).toHaveBeenCalledTimes(1);
    expect(mocks.assetStoreResolve).not.toHaveBeenCalled();
  });

  it('reports missing when the store raises AssetNotFoundError', async () => {
    mocks.assetStoreResolve.mockRejectedValue(new AssetNotFoundError());

    const resolution = await resolveServerAsset(ASSET_ID, authHeaders('shared-secret'));

    expect(resolution).toEqual({ status: 'missing' });
  });

  it('rethrows any other store failure so the route can map it to a generic 500', async () => {
    const failure = new Error('db connection refused');
    mocks.assetStoreResolve.mockRejectedValue(failure);

    await expect(resolveServerAsset(ASSET_ID, authHeaders('shared-secret'))).rejects.toBe(failure);
  });
});
