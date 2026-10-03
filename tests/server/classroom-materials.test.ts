import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getReadyOwnerMaterials: vi.fn(),
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
}));
vi.mock('@/lib/persistence/owner-materials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/owner-materials')>()),
  getReadyOwnerMaterials: mocks.getReadyOwnerMaterials,
}));
vi.mock('@/lib/server/material-extraction/availability', () => ({
  resolveExtractableMimeTypes: async () => new Set(['application/pdf', 'text/markdown']),
}));

import {
  ClassroomMaterialsRejectedError,
  ClassroomMaterialsUnavailableError,
  resolveClassroomMaterials,
} from '@/lib/server/classroom-materials';

function record(id: string, originalName: string, mime = 'application/pdf') {
  return {
    id,
    ownerId: 'owner-1',
    kind: 'source',
    derivedFrom: null,
    mime,
    bytes: 10,
    originalName,
    ossKey: `materials/owner-1/${id}`,
    sha256: 'abc',
    status: 'ready',
    extraction: { status: 'idle' },
    createdAt: 1,
    deletedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  // The store answers in its own order; the caller's order must win.
  mocks.getReadyOwnerMaterials.mockResolvedValue([
    record('mat_b', 'second.md', 'text/markdown'),
    record('mat_a', 'first.pdf'),
  ]);
});

describe('resolveClassroomMaterials', () => {
  it('resolves the owner materials in the requested order', async () => {
    const records = await resolveClassroomMaterials('owner-1', ['mat_a', 'mat_b']);
    expect(records.map((entry) => entry.id)).toEqual(['mat_a', 'mat_b']);
    expect(mocks.getReadyOwnerMaterials).toHaveBeenCalledWith({}, 'owner-1', ['mat_a', 'mat_b']);
  });

  it('refuses when any id does not resolve for the owner', async () => {
    await expect(resolveClassroomMaterials('owner-1', ['mat_a', 'mat_x'])).rejects.toBeInstanceOf(
      ClassroomMaterialsUnavailableError,
    );
  });

  it('refuses a material type no available extractor reads', async () => {
    mocks.getReadyOwnerMaterials.mockResolvedValue([record('mat_a', 'clip.mp4', 'video/mp4')]);
    await expect(resolveClassroomMaterials('owner-1', ['mat_a'])).rejects.toBeInstanceOf(
      ClassroomMaterialsRejectedError,
    );
  });

  it('refuses a selection over the bundle total size', async () => {
    mocks.getReadyOwnerMaterials.mockResolvedValue([
      { ...record('mat_a', 'a.pdf'), bytes: 151 * 1024 * 1024 },
    ]);
    await expect(resolveClassroomMaterials('owner-1', ['mat_a'])).rejects.toThrow(
      /byte total for one classroom/,
    );
  });
});
