/**
 * POST /api/materials/[id]/extraction — the composer's Retry of a failed
 * extraction: restarts it for the owner's own upload only, and refuses one
 * that is running or ready.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestOwnerId: vi.fn(),
  startOwnerMaterialExtractions: vi.fn(),
  getOwnerMaterial: vi.fn(),
  wake: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isServerPersistenceConfigured: () => true,
}));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(
    mocks.resolveRequestOwnerId,
  ),
);
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
}));
vi.mock('@/lib/persistence/owner-materials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/owner-materials')>()),
  startOwnerMaterialExtractions: mocks.startOwnerMaterialExtractions,
  getOwnerMaterial: mocks.getOwnerMaterial,
}));
vi.mock('@/lib/server/materials/extractor-wake', () => ({
  wakeOwnerMaterialExtractor: mocks.wake,
}));

import { POST } from '@/app/api/materials/[id]/extraction/route';

const ID = 'mat_00000000000000000000000000';

function record(status: string) {
  return {
    id: ID,
    ownerId: 'owner-1',
    kind: 'source',
    derivedFrom: null,
    mime: 'application/pdf',
    bytes: 1,
    originalName: 'a.pdf',
    ossKey: 'k',
    sha256: 's',
    status: 'ready',
    extraction: { status },
    createdAt: 0,
    deletedAt: null,
  };
}

const call = (id = ID) =>
  POST(new NextRequest(`http://localhost/api/materials/${id}/extraction`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
});

describe('POST /api/materials/[id]/extraction', () => {
  it("restarts the owner's failed extraction and wakes the extractor", async () => {
    mocks.startOwnerMaterialExtractions.mockResolvedValue([ID]);
    mocks.getOwnerMaterial.mockResolvedValue(record('extracting'));
    const response = await call();
    expect(response.status).toBe(200);
    expect((await response.json()).material.extraction).toEqual({ status: 'extracting' });
    expect(mocks.startOwnerMaterialExtractions).toHaveBeenCalledWith(
      {},
      'owner-1',
      [ID],
      ['failed', 'idle'],
    );
    expect(mocks.wake).toHaveBeenCalled();
  });

  it('refuses an extraction that is running or ready', async () => {
    mocks.startOwnerMaterialExtractions.mockResolvedValue([]);
    mocks.getOwnerMaterial.mockResolvedValue(record('ready'));
    const response = await call();
    expect(response.status).toBe(409);
    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it('answers a plain 404 for an id the owner does not have', async () => {
    mocks.startOwnerMaterialExtractions.mockResolvedValue([]);
    mocks.getOwnerMaterial.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect((await call('not-an-id')).status).toBe(404);
  });
});
