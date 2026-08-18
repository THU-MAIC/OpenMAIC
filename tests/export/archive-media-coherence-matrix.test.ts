import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetManifestEntry } from '@openmaic/dsl';
import type { Scene } from '@/lib/types/stage';
import type { ArchiveMediaKind } from '@/lib/video-export/archive-media';
import type { AssetMeta } from '@/lib/video-export';

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
  collectLegacyAudioForExport,
  collectMediaFiles,
  mediaPosterArchivePath,
} from '@/lib/export/classroom-zip-utils';
import { importedMediaKind } from '@/lib/import/use-import-classroom';
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

function plannedPath(kind: 'audio' | 'video', meta: AssetMeta): string {
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
  return planned.path;
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
          expect(collected.record.mimeType).toBe(
            name === 'valid' ? input.mimeType : expected.fallbackMime,
          );
          expect(importedMediaKind(collected.record.mimeType)).toBe(kind);

          if (kind === 'video') {
            expect(collected.posterZipPath).toBe(mediaPosterArchivePath(0));
            expect(collected.posterZipPath).toBe('media/asset-1.poster.jpg');
            expect(importedMediaKind('image/jpeg')).toBe('image');
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

          const url = `https://example.test/${encodeURIComponent(name)}`;
          mocks.fetchMediaUrl.mockResolvedValueOnce(new Response(blob, { status: 200 }));
          const legacy = await collectLegacyAudioForExport([legacyScene(url)], new Map());
          expect(legacy.blobs[0]?.zipPath).toBe(`audio/legacy-1.${extension}`);
          expect(legacy.blobs[0]?.format).toBe(extension);
        }

        if (kind === 'audio' || kind === 'video') {
          const path = plannedPath(kind, {
            id: `${kind}-${name}`,
            present: true,
            mimeType: input.mimeType,
            format: input.extension,
          });
          expect(path.endsWith(`.${extension}`)).toBe(true);
        }
      }
    },
  );
});
