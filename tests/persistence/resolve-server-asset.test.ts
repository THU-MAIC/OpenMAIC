import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetNotFoundError, toAssetId } from '@openmaic/storage';

import { resolveServerAsset } from '@/lib/persistence/resolve-server-asset';

// Mock only the storage provider seam; the module under test and the
// development authenticator stay real so principal derivation from headers is
// exercised against the actual implementation.
const mocks = vi.hoisted(() => ({
  getServerPersistenceProvider: vi.fn(),
  assetStoreResolve: vi.fn(),
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));

const ASSET_ID = 'ast_unit_test';
const RESOLVED_BYTES = Buffer.from('resolved course material bytes');
const RESOLVED_MIME = 'text/plain';

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
    mocks.assetStoreResolve.mockReset();
    mocks.getServerPersistenceProvider.mockResolvedValue({
      assetStore: { resolve: mocks.assetStoreResolve },
    });
  });

  it('derives the shared principal from a valid bearer token and resolves the asset', async () => {
    mocks.assetStoreResolve.mockResolvedValue({ bytes: RESOLVED_BYTES, mime: RESOLVED_MIME });

    const resolution = await resolveServerAsset(ASSET_ID, authHeaders('shared-secret'));

    expect(resolution).toEqual({
      status: 'resolved',
      buffer: RESOLVED_BYTES,
      mimeType: RESOLVED_MIME,
    });
    expect(mocks.getServerPersistenceProvider).toHaveBeenCalledWith('postgres://test');
    // The development authenticator maps every caller to the single shared
    // asset partition (see server-auth.ts), so the store is addressed by the
    // shared principal, not by any per-header partition.
    expect(mocks.assetStoreResolve).toHaveBeenCalledWith({ key: 'shared' }, toAssetId(ASSET_ID));
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

    const resolution = await resolveServerAsset(ASSET_ID, authHeaders('shared-secret'));

    expect(resolution).toEqual({ status: 'missing' });
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
