import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

const mocks = vi.hoisted(() => ({
  accessDocument: vi.fn(),
  prepareScenes: vi.fn(),
  buildAssetManifest: vi.fn(),
  collectAudioFiles: vi.fn(),
  collectMediaFiles: vi.fn(),
  collectLegacyAudioForExport: vi.fn(),
}));

vi.mock('@/lib/document-store', () => ({ accessDocument: mocks.accessDocument }));
vi.mock('@/lib/pbl/v2/runtime/document-persistence', () => ({
  preparePBLScenesForDocumentPersistence: mocks.prepareScenes,
}));
vi.mock('@/lib/media/asset-manifest', () => ({
  buildStageAssetManifest: mocks.buildAssetManifest,
}));
vi.mock('@/lib/export/classroom-zip-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/export/classroom-zip-utils')>();
  return {
    ...actual,
    collectAudioFiles: mocks.collectAudioFiles,
    collectMediaFiles: mocks.collectMediaFiles,
    collectLegacyAudioForExport: mocks.collectLegacyAudioForExport,
  };
});

import { buildClassroomExportZip } from '@/lib/export/use-export-classroom';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';
import type { Scene, Stage } from '@/lib/types/stage';

const audioId = 'ast_evicted';
const legacyUrl = 'https://server.example.com/audio/evicted.mp3';
const legacyPath = 'audio/legacy-1.mp3';

function fixture() {
  const stage = {
    id: 'stage-1',
    name: 'Legacy rescue',
    generatedAgentConfigs: [],
  } as unknown as Stage;
  const scenes = [
    {
      id: 'scene-1',
      stageId: stage.id,
      title: 'Scene',
      order: 0,
      type: 'slide',
      content: { type: 'slide', canvas: { elements: [] } },
      actions: [{ id: 'speech-1', type: 'speech', text: 'Hello', audioId, audioUrl: legacyUrl }],
    } as unknown as Scene,
  ];
  return { stage, scenes };
}

beforeEach(() => {
  vi.clearAllMocks();
  const { stage, scenes } = fixture();
  mocks.accessDocument.mockResolvedValue({ document: { stage } });
  mocks.prepareScenes.mockResolvedValue(scenes);
  mocks.buildAssetManifest.mockResolvedValue({
    version: 1,
    entries: [{ kind: 'audio', ref: audioId }],
  });
  mocks.collectAudioFiles.mockResolvedValue([]);
  mocks.collectMediaFiles.mockResolvedValue([]);
  mocks.collectLegacyAudioForExport.mockResolvedValue({
    audioUrlToPath: new Map([[legacyUrl, legacyPath]]),
    blobs: [
      {
        zipPath: legacyPath,
        // JSZip's Node adapter accepts typed arrays but not Node's Blob;
        // production supplies a browser Blob with the same byte semantics.
        blob: new Uint8Array([1, 2, 3]) as unknown as Blob,
        format: 'mp3',
        mimeType: 'audio/mpeg',
        sourceRef: legacyUrl,
      },
    ],
    fullyRescuedAudioIds: new Set([audioId]),
  });
});

describe('buildClassroomExportZip missing-audio reporting', () => {
  it('does not report an id-backed narration as missing when its legacy URL supplied bytes', async () => {
    const { stage, scenes } = fixture();

    const result = await buildClassroomExportZip(stage, scenes);
    const zip = await JSZip.loadAsync(await result.zip.arrayBuffer());
    const manifest = JSON.parse(
      await zip.file('manifest.json')!.async('string'),
    ) as ClassroomManifest;

    expect(result.missingAudioCount).toBe(0);
    expect(manifest.scenes[0]?.actions?.[0]).toMatchObject({ audioRef: legacyPath });
    expect(Object.values(manifest.mediaIndex)).not.toContainEqual(
      expect.objectContaining({ sourceRef: audioId, missing: true }),
    );
    const legacyEntry = Object.values(manifest.mediaIndex).find(
      (entry) => entry.sourceRef === legacyUrl,
    );
    expect(legacyEntry).toBeDefined();
    expect(legacyEntry).not.toHaveProperty('missing');
  });

  it('keeps the missing marker when the legacy URL did not rescue every owner', async () => {
    mocks.collectLegacyAudioForExport.mockResolvedValue({
      audioUrlToPath: new Map([[legacyUrl, legacyPath]]),
      blobs: [
        {
          zipPath: legacyPath,
          blob: new Uint8Array([1, 2, 3]) as unknown as Blob,
          format: 'mp3',
          mimeType: 'audio/mpeg',
          sourceRef: legacyUrl,
        },
      ],
      fullyRescuedAudioIds: new Set(),
    });
    const { stage, scenes } = fixture();

    const result = await buildClassroomExportZip(stage, scenes);
    const zip = await JSZip.loadAsync(await result.zip.arrayBuffer());
    const manifest = JSON.parse(
      await zip.file('manifest.json')!.async('string'),
    ) as ClassroomManifest;

    expect(result.missingAudioCount).toBe(1);
    expect(Object.values(manifest.mediaIndex)).toContainEqual(
      expect.objectContaining({ sourceRef: audioId, missing: true }),
    );
  });
});
