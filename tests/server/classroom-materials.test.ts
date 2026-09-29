import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getReadyOwnerMaterials: vi.fn(),
  byteGet: vi.fn(),
  extractMaterialSource: vi.fn(),
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: {} }),
}));
vi.mock('@/lib/persistence/owner-materials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/persistence/owner-materials')>()),
  getReadyOwnerMaterials: mocks.getReadyOwnerMaterials,
}));
vi.mock('@/lib/server/materials/bytes', () => ({
  getMaterialByteStore: () => ({ get: mocks.byteGet }),
}));
vi.mock('@/lib/server/material-extraction/availability', () => ({
  resolveExtractableMimeTypes: async () => new Set(['application/pdf', 'text/markdown']),
}));
vi.mock('@/lib/server/material-extraction/extract', () => ({
  extractMaterialSource: mocks.extractMaterialSource,
}));

import {
  ClassroomMaterialsRejectedError,
  ClassroomMaterialsUnavailableError,
  loadClassroomMaterialText,
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
  mocks.byteGet.mockImplementation(async (key: string) => Buffer.from(`bytes of ${key}`));
  mocks.extractMaterialSource.mockImplementation(async ({ fileName }: { fileName: string }) => ({
    kind: 'document',
    text: `Text of ${fileName}`,
    artifact: { metadata: { pageCount: 2 } },
    extractorVersion: 'test@1',
  }));
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

describe('loadClassroomMaterialText', () => {
  it('extracts each upload from its stored bytes and bundles the texts in order', async () => {
    const text = await loadClassroomMaterialText('owner-1', ['mat_a', 'mat_b']);

    expect(mocks.byteGet.mock.calls.map(([key]) => key)).toEqual([
      'materials/owner-1/mat_a',
      'materials/owner-1/mat_b',
    ]);
    // Extracted with the owner's document and speech services.
    expect(mocks.extractMaterialSource).toHaveBeenCalledWith(
      {
        bytes: Buffer.from('bytes of materials/owner-1/mat_a'),
        mime: 'application/pdf',
        fileName: 'first.pdf',
      },
      { ownerId: 'owner-1' },
    );
    expect(text).toContain('## Source Document 1: first.pdf');
    expect(text).toContain('## Source Document 2: second.md');
    expect(text!.indexOf('Text of first.pdf')).toBeLessThan(text!.indexOf('Text of second.md'));
  });

  it('fails loudly when a material yields no text', async () => {
    mocks.extractMaterialSource.mockResolvedValueOnce({
      kind: 'document',
      text: '  ',
      artifact: { metadata: {} },
      extractorVersion: 'test@1',
    });
    await expect(loadClassroomMaterialText('owner-1', ['mat_a'])).rejects.toThrow(
      'Material "first.pdf" produced no extractable text',
    );
  });

  it('reports unreadable bytes as an unavailable material', async () => {
    mocks.byteGet.mockRejectedValueOnce(new Error('ENOENT'));
    await expect(loadClassroomMaterialText('owner-1', ['mat_a'])).rejects.toBeInstanceOf(
      ClassroomMaterialsUnavailableError,
    );
  });
});
