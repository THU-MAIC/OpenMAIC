import { beforeEach, describe, expect, test, vi } from 'vitest';

const importerMocks = vi.hoisted(() => {
  const state: { document: unknown | null } = { document: null };
  return {
    state,
    putAsset: vi.fn(),
    removeAsset: vi.fn(),
    putAudio: vi.fn(),
    putMedia: vi.fn(),
    deleteAudioRows: vi.fn(),
    deleteMediaRows: vi.fn(),
    deleteMetadata: vi.fn(),
    startImportJob: vi.fn(),
    updateImportJob: vi.fn(),
    upsertCourseMetadata: vi.fn(),
    completeImportJob: vi.fn(),
    failImportJob: vi.fn(),
    saveDocument: vi.fn(),
    deleteDocument: vi.fn(),
  };
});

vi.mock('@/lib/media/asset-pool', () => ({
  putAsset: importerMocks.putAsset,
  removeAsset: importerMocks.removeAsset,
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    audioFiles: {
      put: importerMocks.putAudio,
      where: () => ({ equals: () => ({ delete: importerMocks.deleteAudioRows }) }),
    },
    mediaFiles: {
      put: importerMocks.putMedia,
      where: () => ({ equals: () => ({ delete: importerMocks.deleteMediaRows }) }),
    },
    courseMetadata: { delete: importerMocks.deleteMetadata },
  },
}));

vi.mock('@/lib/document-store', () => ({
  canonicalizeLegacyScene: (scene: Record<string, unknown>) => ({
    ...scene,
    type: (scene.content as { type: string }).type,
  }),
  mutateDocument: async (
    _stageId: string,
    work: (
      document: unknown,
      store: {
        saveDocument: (document: unknown) => Promise<void>;
        deleteDocument: () => Promise<void>;
      },
    ) => Promise<unknown>,
  ) =>
    work(importerMocks.state.document, {
      saveDocument: async (document) => {
        importerMocks.saveDocument(document);
        importerMocks.state.document = document;
      },
      deleteDocument: async () => {
        importerMocks.deleteDocument();
        importerMocks.state.document = null;
      },
    }),
}));

vi.mock('@/lib/workspace', () => ({
  startImportJob: importerMocks.startImportJob,
  updateImportJob: importerMocks.updateImportJob,
  upsertCourseMetadata: importerMocks.upsertCourseMetadata,
  completeImportJob: importerMocks.completeImportJob,
  failImportJob: importerMocks.failImportJob,
}));

import { scanClassroomPackage } from '@/lib/import/classroom-package/scanner';
import { buildMediaElementIdMap } from '@/lib/import/classroom-package/media-refs';
import { importClassroomPackage } from '@/lib/import/classroom-package/importer';

interface TestManifest {
  formatVersion: number;
  exportedAt: string;
  appVersion: string;
  stage: { name: string; createdAt: number; updatedAt: number };
  agents: Array<{
    name: string;
    role: string;
    persona: string;
    avatar: string;
    color: string;
    priority: number;
  }>;
  scenes: Array<{
    type: string;
    title: string;
    order: number;
    content: { type: string; canvas: { id: string; elements: unknown[] } };
    actions: unknown[];
  }>;
  mediaIndex: Record<string, unknown>;
}

function validManifest(): TestManifest {
  return {
    formatVersion: 1,
    exportedAt: '2026-08-13T00:00:00.000Z',
    appVersion: 'test',
    stage: { name: '测试课程', createdAt: 1, updatedAt: 1 },
    agents: [
      {
        name: '教师',
        role: 'teacher',
        persona: '耐心讲解',
        avatar: '/teacher.png',
        color: '#2563eb',
        priority: 1,
      },
    ],
    scenes: [
      {
        type: 'slide',
        title: '第一页',
        order: 0,
        content: { type: 'slide', canvas: { id: 'slide-1', elements: [] } },
        actions: [],
      },
    ],
    mediaIndex: {},
  };
}

function virtualPackage(manifest: unknown, resources: Record<string, string> = {}) {
  return {
    kind: 'virtual' as const,
    name: 'test.maic.zip',
    files: [
      { path: 'manifest.json', body: JSON.stringify(manifest) },
      ...Object.entries(resources).map(([path, body]) => ({ path, body })),
    ],
  };
}

beforeEach(() => {
  importerMocks.state.document = null;
  vi.clearAllMocks();
  let assetSequence = 0;
  importerMocks.putAsset.mockImplementation(async () => `asset-${++assetSequence}`);
  importerMocks.removeAsset.mockResolvedValue(undefined);
  importerMocks.putAudio.mockResolvedValue(undefined);
  importerMocks.putMedia.mockResolvedValue(undefined);
  importerMocks.deleteAudioRows.mockResolvedValue(undefined);
  importerMocks.deleteMediaRows.mockResolvedValue(undefined);
  importerMocks.deleteMetadata.mockResolvedValue(undefined);
  importerMocks.startImportJob.mockResolvedValue({ id: 'import-job-1' });
  importerMocks.updateImportJob.mockResolvedValue({ id: 'import-job-1' });
  importerMocks.upsertCourseMetadata.mockResolvedValue({ stageId: 'stage' });
  importerMocks.completeImportJob.mockResolvedValue({ id: 'import-job-1' });
  importerMocks.failImportJob.mockResolvedValue({ id: 'import-job-1' });
});

describe('classroom package manifest validation', () => {
  test.each([
    [
      'non-array actions',
      (manifest: TestManifest) => {
        manifest.scenes[0].actions = {} as never;
      },
    ],
    [
      'null agent',
      (manifest: TestManifest) => {
        manifest.agents[0] = null as never;
      },
    ],
    [
      'agent missing required string',
      (manifest: TestManifest) => {
        manifest.agents[0].role = '';
      },
    ],
    [
      'non-record media index',
      (manifest: TestManifest) => {
        manifest.mediaIndex = [] as never;
      },
    ],
    [
      'invalid scene type',
      (manifest: TestManifest) => {
        manifest.scenes[0].type = 'movie';
      },
    ],
    [
      'mismatched content type',
      (manifest: TestManifest) => {
        manifest.scenes[0].content.type = 'quiz';
      },
    ],
  ])('rejects %s', async (_label, mutate) => {
    const manifest = validManifest();
    mutate(manifest);
    await expect(scanClassroomPackage(virtualPackage(manifest))).rejects.toMatchObject({
      code: 'invalid-manifest',
    });
  });
});

describe('generated media preflight', () => {
  test('marks an unindexed scene placeholder as missing and partial', async () => {
    const manifest = validManifest();
    manifest.scenes[0].content.canvas.elements = [
      { id: 'image-1', type: 'image', src: 'gen_img_missing' },
    ] as never;

    const scan = await scanClassroomPackage(virtualPackage(manifest));

    expect(scan.preview.missingResources).toContainEqual(
      expect.objectContaining({
        path: 'gen_img_missing',
        reason: 'unindexed-reference',
        referencedBy: expect.stringContaining('scenes[0].content'),
      }),
    );
    expect(scan.preview.offlineLevel).toBe('partial');
    expect(scan.preview.canImport).toBe(true);
  });

  test('keeps the package complete when the indexed placeholder bytes exist', async () => {
    const manifest = validManifest();
    manifest.scenes[0].content.canvas.elements = [
      { id: 'image-1', type: 'image', src: 'gen_img_present' },
    ] as never;
    manifest.mediaIndex = {
      'media/gen_img_present.png': { type: 'generated', mimeType: 'image/png' },
    };

    const scan = await scanClassroomPackage(
      virtualPackage(manifest, { 'media/gen_img_present.png': 'image bytes' }),
    );

    expect(scan.preview.missingResources).toEqual([]);
    expect(scan.preview.offlineLevel).toBe('complete');
  });
});

describe('import media element IDs', () => {
  test('preserves the canonical placeholder and deterministically disambiguates duplicate basenames', () => {
    const paths = ['extras/gen_img_same.png', 'media/gen_img_same.png'];
    const first = buildMediaElementIdMap(paths);
    const second = buildMediaElementIdMap([...paths].reverse());

    expect(first.get('media/gen_img_same.png')).toBe('gen_img_same');
    expect(first.get('extras/gen_img_same.png')).toMatch(/^gen_img_same__[a-z0-9]+$/);
    expect(new Set(first.values()).size).toBe(2);
    expect([...second]).toEqual([...first]);
  });
});

describe('v0.3.2 document-store import', () => {
  function packageWithLocalAssets() {
    const manifest = validManifest();
    manifest.scenes[0].content.canvas.elements = [
      { id: 'image-1', type: 'image', src: 'gen_img_present' },
    ] as never;
    manifest.scenes[0].actions = [
      { id: 'speech-1', type: 'speech', text: '讲解', audioRef: 'audio/line.mp3' },
    ];
    manifest.mediaIndex = {
      'audio/line.mp3': { type: 'audio', mimeType: 'audio/mpeg', format: 'mp3' },
      'media/gen_img_present.png': { type: 'generated', mimeType: 'image/png' },
    };
    return virtualPackage(manifest, {
      'audio/line.mp3': 'audio bytes',
      'media/gen_img_present.png': 'image bytes',
    });
  }

  test('commits one aggregate document with asset-pool refs and embedded roster', async () => {
    const scan = await scanClassroomPackage(packageWithLocalAssets());
    const result = await importClassroomPackage(scan);

    expect(result).toMatchObject({
      importJobId: 'import-job-1',
      sceneCount: 1,
      audioCount: 1,
      mediaCount: 1,
    });
    expect(importerMocks.saveDocument).toHaveBeenCalledOnce();
    const document = importerMocks.saveDocument.mock.calls[0][0] as {
      stage: { generatedAgentConfigs?: Array<{ name: string }> };
      scenes: Array<{
        content: { canvas: { elements: Array<{ src: string }> } };
        actions: Array<{ audioId?: string; audioRef?: string }>;
      }>;
    };
    expect(document.stage.generatedAgentConfigs?.[0]?.name).toBe('教师');
    expect(document.scenes[0].content.canvas.elements[0].src).toBe('asset-2');
    expect(document.scenes[0].actions[0]).toMatchObject({ audioId: 'asset-1' });
    expect(document.scenes[0].actions[0]).not.toHaveProperty('audioRef');
    expect(importerMocks.upsertCourseMetadata).toHaveBeenCalledWith(
      result.stageId,
      expect.objectContaining({ offlineStatus: 'complete' }),
    );
    expect(importerMocks.completeImportJob).toHaveBeenCalledWith(
      'import-job-1',
      result.stageId,
      expect.objectContaining({ offlineStatus: 'complete' }),
    );
  });

  test('compensates the document, mirrors, metadata, and pool when finalization fails', async () => {
    importerMocks.completeImportJob.mockRejectedValueOnce(new Error('history unavailable'));
    const scan = await scanClassroomPackage(packageWithLocalAssets());

    await expect(importClassroomPackage(scan)).rejects.toMatchObject({ code: 'import-failed' });

    expect(importerMocks.deleteDocument).toHaveBeenCalled();
    expect(importerMocks.state.document).toBeNull();
    expect(importerMocks.deleteMetadata).toHaveBeenCalled();
    expect(importerMocks.deleteAudioRows).toHaveBeenCalled();
    expect(importerMocks.deleteMediaRows).toHaveBeenCalled();
    expect(importerMocks.removeAsset).toHaveBeenCalledTimes(2);
    expect(importerMocks.failImportJob).toHaveBeenCalledWith(
      'import-job-1',
      expect.objectContaining({ code: 'import-failed' }),
    );
  });
});
