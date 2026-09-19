/**
 * Contract coverage: 6 metadata cases × 7 archive surfaces = 42 cells.
 * Each classroom surface follows every end-to-end link it supports: canonical
 * path, serialized metadata, and import-side kind/content-type coherence. The
 * two planner surfaces additionally pin the exact path and kind metadata.
 *
 * The boundary is intentional: kind metadata is authoritative. Export does not
 * inspect or transcode payload bytes, so this matrix validates coherent labels,
 * not whether already-stored bytes match them. A byte/kind mismatch is corrupt
 * store state outside the export contract, just as it is for runtime/renderers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetManifestEntry } from '@openmaic/dsl';
import type { MediaIndexEntry } from '@/lib/export/classroom-zip-types';
import type { Scene } from '@/lib/types/stage';
import { canonicalArchiveMedia, type ArchiveMediaKind } from '@/lib/video-export/archive-media';
import type { AssetMeta } from '@/lib/video-export';
import type { AssetPlanEntry } from '@/lib/video-export/ir';

const mocks = vi.hoisted(() => ({
  audioRows: new Map<string, { id: string; blob: Blob; format: string }>(),
  mediaRows: new Map<
    string,
    {
      id: string;
      stageId: string;
      type: 'image' | 'video';
      blob: Blob;
      mimeType: string;
      size: number;
      prompt: string;
      params: string;
      createdAt: number;
      poster?: Blob;
    }
  >(),
  resolveAudioBlob: vi.fn(),
  resolveStoredBytes: vi.fn(),
  fetchMediaUrl: vi.fn(),
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    audioFiles: { get: async (id: string) => mocks.audioRows.get(id) },
    mediaFiles: { get: async (id: string) => mocks.mediaRows.get(id) },
  },
}));
vi.mock('@/lib/media/resolve-audio-bytes', () => ({
  resolveAudioBlob: (...args: unknown[]) => mocks.resolveAudioBlob(...args),
}));
vi.mock('@/lib/media/resolve-stored-bytes', () => ({
  resolveStoredBytes: (...args: unknown[]) => mocks.resolveStoredBytes(...args),
}));
vi.mock('@/lib/media/fetch-media-url', () => ({
  fetchMediaUrl: (...args: unknown[]) => mocks.fetchMediaUrl(...args),
}));
vi.mock('@/lib/media/convert-legacy-asset-refs', () => ({
  mapWithConcurrency: async <T, R>(
    items: T[],
    _limit: number,
    fn: (item: T, index: number) => Promise<R>,
  ) => Promise.all(items.map(fn)),
}));

import {
  collectAudioFiles,
  collectedAudioMediaIndexEntry,
  collectedMediaIndexEntry,
  collectLegacyAudioForExport,
  collectMediaFiles,
  mediaPosterArchiveMetadata,
  mediaPosterArchivePath,
  legacyAudioMediaIndexEntry,
} from '@/lib/export/classroom-zip-utils';
import { importedAudioContentType, importedMediaKind } from '@/lib/import/use-import-classroom';
import {
  buildTimeline,
  buildTimelineOptions,
  normalizeScenes,
  planAssets,
} from '@/lib/video-export';
import { playVideo, slide, speech, stubAssets, stubProbe } from '../video-export/helpers';

interface MetadataCase {
  name: string;
  value(kind: ArchiveMediaKind): { mimeType: string; extension: string };
}

const metadataCases: MetadataCase[] = [
  {
    name: 'valid',
    value: (kind) =>
      ({
        image: { mimeType: 'image/png', extension: 'png' },
        video: { mimeType: 'video/webm', extension: 'webm' },
        audio: { mimeType: 'audio/wav', extension: 'wav' },
      })[kind],
  },
  { name: 'empty', value: () => ({ mimeType: '', extension: '' }) },
  {
    name: 'application/octet-stream',
    value: () => ({ mimeType: 'application/octet-stream', extension: 'application/octet-stream' }),
  },
  {
    name: 'contradictory allowlisted',
    value: (kind) =>
      kind === 'image'
        ? { mimeType: 'video/mp4', extension: 'mp4' }
        : { mimeType: 'image/jpeg', extension: 'jpg' },
  },
  {
    name: 'non-allowlisted',
    value: (kind) =>
      ({
        image: { mimeType: 'image/tiff', extension: 'tiff' },
        video: { mimeType: 'video/x-matroska', extension: 'mkv' },
        audio: { mimeType: 'audio/aiff', extension: 'aiff' },
      })[kind],
  },
  { name: 'uppercase compound', value: () => ({ mimeType: 'TAR.GZ', extension: 'TAR.GZ' }) },
];

const expectedByKind = {
  image: { fallbackExtension: 'jpg', fallbackMime: 'image/jpeg', validExtension: 'png' },
  video: { fallbackExtension: 'mp4', fallbackMime: 'video/mp4', validExtension: 'webm' },
  audio: { fallbackExtension: 'mp3', fallbackMime: 'audio/mpeg', validExtension: 'wav' },
} as const;

const entry = (ref: string, kind: AssetManifestEntry['kind']): AssetManifestEntry => ({
  ref,
  kind,
});

function legacyScene(url: string): Scene {
  return slide('legacy', [speech('speech', 'Narration', { audioUrl: url })]) as unknown as Scene;
}

function plannedEntry(kind: 'audio' | 'video', meta: AssetMeta): AssetPlanEntry {
  const scene =
    kind === 'audio'
      ? slide('scene', [speech('speech', 'Narration')])
      : slide('scene', [playVideo('play', 'clip')]);
  const source = normalizeScenes([scene]).scenes;
  const timeline = buildTimeline(source, buildTimelineOptions(stubProbe({}, { play: 1_000 })));
  const assets = kind === 'audio' ? stubAssets({ speech: meta }) : stubAssets({}, { clip: meta });
  const result = planAssets(source, timeline.scenes, assets);
  const planned = result.plan.entries.find((item) => item.kind === kind);
  if (!planned) throw new Error(`Missing ${kind} plan entry`);
  return planned;
}

function expectImportedMediaMetadata(mimeType: string, kind: 'image' | 'video'): void {
  // materializeImportedMedia forwards the serialized MIME as pool contentType
  // and derives mediaType through importedMediaKind.
  expect(mimeType.startsWith(`${kind}/`)).toBe(true);
  expect(importedMediaKind(mimeType)).toBe(kind);
}

function expectImportedAudioMetadata(metadata: MediaIndexEntry): void {
  expect(metadata.type).toBe('audio');
  expect(metadata.mimeType?.startsWith('audio/')).toBe(true);
  expect(importedAudioContentType(metadata, '')).toBe(metadata.mimeType);
  expect(canonicalArchiveMedia('audio', { extension: metadata.format })).toEqual({
    extension: metadata.format,
    mimeType: metadata.mimeType,
  });
}

afterEach(() => {
  mocks.audioRows.clear();
  mocks.mediaRows.clear();
  vi.clearAllMocks();
});

describe('archive media coherence coverage matrix', () => {
  it.each(metadataCases)(
    'makes every archive surface canonical for $name metadata',
    async ({ name, value }) => {
      let assertedCells = 0;
      for (const kind of ['image', 'video', 'audio'] as const) {
        const input = value(kind);
        const expected = expectedByKind[kind];
        const extension = name === 'valid' ? expected.validExtension : expected.fallbackExtension;

        if (kind === 'image' || kind === 'video') {
          const ref = `${kind}-${name}`;
          const blob = new Blob([kind], { type: input.mimeType });
          mocks.mediaRows.set(`stage:${ref}`, {
            id: `stage:${ref}`,
            stageId: 'stage',
            type: kind,
            blob,
            mimeType: input.mimeType,
            size: blob.size,
            prompt: '',
            params: '',
            createdAt: 0,
            ...(kind === 'video' ? { poster: new Blob(['poster'], { type: input.mimeType }) } : {}),
          });
          mocks.resolveStoredBytes.mockResolvedValueOnce(blob);

          const [collected] = await collectMediaFiles('stage', [entry(ref, kind)]);
          expect(collected.zipPath).toBe(`media/asset-1.${extension}`);
          const serializedMime = name === 'valid' ? input.mimeType : expected.fallbackMime;
          const serialized = collectedMediaIndexEntry(collected);
          expect(serialized.mimeType).toBe(serializedMime);
          expectImportedMediaMetadata(serialized.mimeType!, kind);
          assertedCells += 1;

          if (kind === 'video') {
            const posterMetadata = mediaPosterArchiveMetadata();
            expect(collected.posterZipPath).toBe(mediaPosterArchivePath(0));
            expect(collected.posterZipPath).toBe(
              `media/asset-1.poster.${posterMetadata.extension}`,
            );
            expectImportedMediaMetadata(posterMetadata.mimeType, 'image');
            assertedCells += 1;
          }
        }

        if (kind === 'audio') {
          const ref = `audio-${name}`;
          const blob = new Blob(['audio'], { type: input.mimeType });
          mocks.audioRows.set(ref, { id: ref, blob, format: input.extension });
          mocks.resolveAudioBlob.mockResolvedValueOnce(blob);

          const [collected] = await collectAudioFiles([entry(ref, 'audio')]);
          expect(collected.zipPath).toBe(`audio/audio-1.${extension}`);
          expect(collected.record.format).toBe(extension);
          expect(collected.mimeType).toBe(
            name === 'valid' ? input.mimeType : expected.fallbackMime,
          );
          expectImportedAudioMetadata(collectedAudioMediaIndexEntry(collected));
          assertedCells += 1;

          const url = `https://example.test/${encodeURIComponent(name)}`;
          mocks.fetchMediaUrl.mockResolvedValueOnce(new Response(blob, { status: 200 }));
          const legacy = await collectLegacyAudioForExport([legacyScene(url)], new Map());
          expect(legacy.blobs[0]?.zipPath).toBe(`audio/legacy-1.${extension}`);
          expect(legacy.blobs[0]?.format).toBe(extension);
          expect(legacy.blobs[0]?.mimeType).toBe(
            name === 'valid' ? input.mimeType : expected.fallbackMime,
          );
          // Legacy narration carries the URL it was fetched from as its source
          // ref, so every audio surface preserves an explicit original ref.
          expect(legacy.blobs[0]?.sourceRef).toBe(url);
          const serializedLegacy = legacyAudioMediaIndexEntry(legacy.blobs[0]!);
          expect(serializedLegacy.sourceRef).toBe(url);
          expectImportedAudioMetadata(serializedLegacy);
          assertedCells += 1;
        }

        if (kind === 'audio' || kind === 'video') {
          const planned = plannedEntry(kind, {
            id: `${kind}-${name}`,
            present: true,
            mimeType: input.mimeType,
            format: input.extension,
          });
          expect(planned).toMatchObject({
            assetId: `${kind}-${name}`,
            kind,
            path:
              kind === 'audio'
                ? `audio/001-scene/speech-001.${extension}`
                : `media/clip.${extension}`,
            present: true,
          });
          expect(
            canonicalArchiveMedia(kind, {
              extension: input.extension,
              mimeType: input.mimeType,
            }),
          ).toEqual({
            extension,
            mimeType: name === 'valid' ? input.mimeType : expected.fallbackMime,
          });
          assertedCells += 1;
        }
      }
      expect(assertedCells).toBe(7);
    },
  );

  it('trusts authoritative kind labels without inspecting or transcoding mismatched bytes', async () => {
    // Boundary pin: this record is deliberately corrupt. Its authoritative kind
    // says video while its payload was produced with image metadata. The export
    // contract promises deterministic video labels, no crash, unchanged bytes,
    // and import classification from serialized metadata -- never byte sniffing.
    const ref = 'mismatched-video-record';
    const imageBytes = new Blob(['actually-image-labelled'], { type: 'image/png' });
    mocks.mediaRows.set(`stage:${ref}`, {
      id: `stage:${ref}`,
      stageId: 'stage',
      type: 'video',
      blob: imageBytes,
      mimeType: 'image/png',
      size: imageBytes.size,
      prompt: '',
      params: '',
      createdAt: 0,
    });
    mocks.resolveStoredBytes.mockResolvedValueOnce(imageBytes);

    const [collected] = await collectMediaFiles('stage', [entry(ref, 'video')]);

    expect(collected.zipPath).toBe('media/asset-1.mp4');
    expect(collected.record.type).toBe('video');
    expect(collected.record.mimeType).toBe('video/mp4');
    expect(collected.record.blob).toBe(imageBytes);
    expect(collected.record.blob.type).toBe('image/png');
    expect(await collected.record.blob.text()).toBe('actually-image-labelled');
    const serialized = collectedMediaIndexEntry(collected);
    expectImportedMediaMetadata(serialized.mimeType!, 'video');
  });
});
