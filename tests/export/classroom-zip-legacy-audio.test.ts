import { afterEach, describe, expect, it, vi } from 'vitest';

// Drives the legacy-URL export path end to end through the real helpers:
// URL collection, proxy fetching, zip-path assignment, and the manifest
// mapping -- everything except the hook plumbing and the final zip write.
const { fetchMediaUrlMock, resolveAudioBlobMock } = vi.hoisted(() => ({
  fetchMediaUrlMock: vi.fn(),
  resolveAudioBlobMock: vi.fn(),
}));

vi.mock('@/lib/media/fetch-media-url', () => ({
  fetchMediaUrl: (...args: unknown[]) => fetchMediaUrlMock(...args),
}));
vi.mock('@/lib/utils/database', () => ({
  db: { audioFiles: { get: vi.fn() } },
}));
vi.mock('@/lib/media/convert-legacy-asset-refs', () => ({
  mapWithConcurrency: async (
    items: unknown[],
    _limit: number,
    fn: (item: unknown, index: number) => Promise<unknown>,
  ) => Promise.all(items.map((item, index) => fn(item, index))),
}));
vi.mock('@/lib/media/resolve-audio-bytes', () => ({ resolveAudioBlob: resolveAudioBlobMock }));
vi.mock('@/lib/media/use-asset-url', () => ({ withAssetUrl: vi.fn() }));
vi.mock('@/lib/media/resolve-media-ref', () => ({ isConcreteMediaAddress: vi.fn() }));

import {
  actionsToManifest,
  collectAudioFiles,
  collectLegacyAudioForExport,
  legacyAudioMediaIndexEntry,
} from '@/lib/export/classroom-zip-utils';
import type { Scene } from '@/lib/types/stage';

function sceneWithSpeech(actions: unknown[]): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    title: 'Scene',
    order: 0,
    type: 'slide',
    content: { type: 'slide', canvas: { elements: [] } },
    actions,
  } as unknown as Scene;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('legacy audio URL export', () => {
  it('fetches dangling narration through the proxy helper and maps it into the manifest', async () => {
    const url = 'https://server.example.com/audio/narration.mp3';
    fetchMediaUrlMock.mockResolvedValue(
      new Response(new Blob(['narration-bytes'], { type: 'audio/mpeg' }), { status: 200 }),
    );
    const action = { id: 'a1', type: 'speech', text: 'Hi', audioId: 'tts_dangling', audioUrl: url };
    const scenes = [sceneWithSpeech([action])];

    const { audioUrlToPath, blobs } = await collectLegacyAudioForExport(scenes, new Map());

    expect(fetchMediaUrlMock).toHaveBeenCalledWith(url, 15_000);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.zipPath).toBe('audio/legacy-1.mpeg');
    expect(await blobs[0]?.blob.text()).toBe('narration-bytes');
    // The legacy URL itself is the natural source ref and travels with the
    // fetched asset into the serialized media index.
    expect(blobs[0]?.sourceRef).toBe(url);
    expect(legacyAudioMediaIndexEntry(blobs[0]!)).toMatchObject({
      type: 'audio',
      sourceRef: url,
      format: 'mpeg',
      mimeType: 'audio/mpeg',
    });

    const manifest = actionsToManifest(
      scenes[0].actions as never,
      new Map(),
      new Map(),
      audioUrlToPath,
    );
    expect(manifest[0]).toMatchObject({ audioRef: 'audio/legacy-1.mpeg' });
    expect(manifest[0]).not.toHaveProperty('audioUrl');
    expect(manifest[0]).not.toHaveProperty('audioId');
  });

  it('skips the fetch when the stamped id already has bytes in the archive', async () => {
    const url = 'https://server.example.com/audio/covered.mp3';
    const action = { id: 'a1', type: 'speech', text: 'Hi', audioId: 'ast_have', audioUrl: url };
    const scenes = [sceneWithSpeech([action])];

    const { blobs } = await collectLegacyAudioForExport(
      scenes,
      new Map([['ast_have', 'audio/ast_have.mp3']]),
    );

    expect(fetchMediaUrlMock).not.toHaveBeenCalled();
    expect(blobs).toHaveLength(0);
  });

  it('exports no audio entry for a URL that will not fetch, without leaking the field', async () => {
    const url = 'https://server.example.com/audio/gone.mp3';
    fetchMediaUrlMock.mockResolvedValue(new Response(null, { status: 404 }));
    const action = { id: 'a1', type: 'speech', text: 'Hi', audioUrl: url };
    const scenes = [sceneWithSpeech([action])];

    const { audioUrlToPath, blobs } = await collectLegacyAudioForExport(scenes, new Map());
    const manifest = actionsToManifest(
      scenes[0].actions as never,
      new Map(),
      new Map(),
      audioUrlToPath,
    );

    expect(blobs).toHaveLength(0);
    expect(manifest[0]).not.toHaveProperty('audioRef');
    expect(manifest[0]).not.toHaveProperty('audioUrl');
  });

  it('an evicted row with no usable bytes produces no zip path, so the live URL is rescued', async () => {
    // Finding: collectAudioFiles included a row whenever `record` was
    // truthy, even when its blob was empty and the pool resolve came back
    // empty (an evicted row). The archive then shipped an empty
    // `audio/<id>.mp3`, and because audioIdToPath contained the id,
    // collectLegacyAudioForExport skipped the live co-present URL.
    const url = 'https://server.example.com/audio/evicted.mp3';
    const audioId = 'ast_evicted';
    const { db } = await import('@/lib/utils/database');
    (db.audioFiles.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: audioId,
      stageId: 'stage-1',
      blob: new Blob([]),
      format: 'mp3',
      text: 'Hi',
      createdAt: 1,
    });
    resolveAudioBlobMock.mockResolvedValue(null);
    fetchMediaUrlMock.mockResolvedValue(
      new Response(new Blob(['url-bytes'], { type: 'audio/mpeg' }), { status: 200 }),
    );
    const action = { id: 'a1', type: 'speech', text: 'Hi', audioId, audioUrl: url };
    const scenes = [sceneWithSpeech([action])];

    // No empty audio entry is collected for the evicted row...
    const collected = await collectAudioFiles([{ ref: audioId, kind: 'audio' }]);
    expect(collected).toHaveLength(0);

    // ...so the id is missing from the archive map and the URL rescue
    // fetches the live narration instead of being skipped.
    const audioIdToPath = new Map(collected.map((c) => [c.record.id, c.zipPath]));
    const { blobs } = await collectLegacyAudioForExport(scenes, audioIdToPath);
    expect(fetchMediaUrlMock).toHaveBeenCalledWith(url, 15_000);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.zipPath).toBe('audio/legacy-1.mpeg');
    expect(await blobs[0]?.blob.text()).toBe('url-bytes');
  });

  it('a row with usable row bytes still ships even when the pool resolve is empty', async () => {
    // The pool resolve can fail (pool unavailable) while the compatibility
    // row itself carries the narration; that row must still reach the ZIP.
    const audioId = 'ast_row_backed';
    const { db } = await import('@/lib/utils/database');
    (db.audioFiles.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: audioId,
      stageId: 'stage-1',
      blob: new Blob(['row-bytes'], { type: 'audio/mpeg' }),
      format: 'mp3',
      text: 'Hi',
      createdAt: 1,
    });
    resolveAudioBlobMock.mockResolvedValue(new Blob(['row-bytes'], { type: 'audio/mpeg' }));

    const collected = await collectAudioFiles([{ ref: audioId, kind: 'audio' }]);

    expect(collected).toHaveLength(1);
    expect(collected[0]?.zipPath).toBe('audio/audio-1.mp3');
    expect(await collected[0]?.record.blob.text()).toBe('row-bytes');
  });

  it('assigns distinct safe paths without interpolating adversarial audio refs', async () => {
    const refs = ['../evil', 'a/b', 'a/../collision', 'collision'];
    const { db } = await import('@/lib/utils/database');
    (db.audioFiles.get as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => ({
      id,
      stageId: 'stage-1',
      blob: new Blob([id], { type: 'audio/mpeg' }),
      format: 'mp3',
      createdAt: 1,
    }));
    resolveAudioBlobMock.mockImplementation(
      async (id: string) => new Blob([id], { type: 'audio/mpeg' }),
    );

    const collected = await collectAudioFiles(refs.map((ref) => ({ ref, kind: 'audio' })));

    expect(collected.map(({ zipPath }) => zipPath)).toEqual([
      'audio/audio-1.mp3',
      'audio/audio-2.mp3',
      'audio/audio-3.mp3',
      'audio/audio-4.mp3',
    ]);
    expect(new Set(collected.map(({ zipPath }) => zipPath)).size).toBe(refs.length);
    expect(collected.map(({ sourceRef }) => sourceRef)).toEqual(refs);
  });

  it.each(['/../../evil', 'png/../x', '', undefined])(
    're-exports imported audio format %s under a safe canonical path',
    async (format) => {
      const audioId = 'ast_imported_audio';
      const { db } = await import('@/lib/utils/database');
      (db.audioFiles.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: audioId,
        stageId: 'stage-1',
        blob: new Blob(['imported']),
        format,
        createdAt: 1,
      });
      resolveAudioBlobMock.mockResolvedValue(new Blob(['imported']));

      const collected = await collectAudioFiles([{ ref: audioId, kind: 'audio' }]);

      expect(collected[0]?.zipPath).toBe('audio/audio-1.mp3');
      expect(collected[0]?.record.format).toBe('mp3');
      expect(collected[0]?.zipPath).not.toMatch(/(?:\.\.|\\)/);
    },
  );

  it.each(['audio//../../evil', 'audio/png/../x', ''])(
    'uses the canonical fallback for malformed legacy narration MIME %s',
    async (mimeType) => {
      const url = 'https://server.example.com/audio/imported';
      fetchMediaUrlMock.mockResolvedValue(
        new Response(new Blob(['narration-bytes'], { type: mimeType }), { status: 200 }),
      );

      const { blobs } = await collectLegacyAudioForExport(
        [sceneWithSpeech([{ id: 'a1', type: 'speech', text: 'Hi', audioUrl: url }])],
        new Map(),
      );

      expect(blobs[0]?.zipPath).toBe('audio/legacy-1.mp3');
      expect(blobs[0]?.format).toBe('mp3');
    },
  );
});
