import JSZip from 'jszip';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpAssetStore, toAssetId, type AssetBytes, type AssetStore } from '@openmaic/storage';
import { createAssetHttpHandler } from '@openmaic/storage/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetMeta, Slide } from '@openmaic/dsl';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';

const mocks = vi.hoisted(() => ({
  serverBacked: vi.fn(),
  put: vi.fn(),
  mediaPut: vi.fn(),
  audioPut: vi.fn(),
}));

vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: mocks.serverBacked,
}));
vi.mock('@/lib/media/asset-pool', () => ({ putAsset: mocks.put }));
vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: { mediaFiles: { put: mocks.mediaPut }, audioFiles: { put: mocks.audioPut } },
}));

import {
  materializeImportedAudio,
  materializeImportedMedia,
  rewriteImportedSlideMediaRefs,
} from '@/lib/import/use-import-classroom';
import { rewriteAudioRefsToIds } from '@/lib/export/classroom-zip-utils';

function archive(withIndexedPoster = false) {
  const zip = new JSZip();
  zip.file('audio/speech.mp3', 'narration');
  zip.file('media/picture.png', 'image');
  zip.file('media/clip.mp4', 'video');
  zip.file('media/clip.poster.jpg', 'poster');
  if (withIndexedPoster) zip.file('media/cover.jpg', 'poster');
  const slide = {
    id: 'slide',
    elements: [
      { id: 'image', type: 'image', src: 'picture' },
      { id: 'video', type: 'video', src: 'clip', mediaRef: 'clip', poster: 'cover' },
      { id: 'audio', type: 'audio', src: 'speech' },
    ],
  } as unknown as Slide;
  const manifest = {
    formatVersion: 1,
    exportedAt: new Date(0).toISOString(),
    appVersion: 'test',
    stage: { name: 'Portable import', createdAt: 1, updatedAt: 1 },
    agents: [],
    scenes: [{ title: 'Slide', order: 0, content: { type: 'slide', canvas: slide } }],
    mediaIndex: {
      'audio/speech.mp3': { type: 'audio', format: 'mp3', duration: 2, voice: 'voice' },
      'media/picture.png': { type: 'image', mimeType: 'image/png', prompt: 'picture' },
      'media/clip.mp4': { type: 'generated', mimeType: 'video/mp4' },
      ...(withIndexedPoster
        ? { 'media/cover.jpg': { type: 'image', mimeType: 'image/jpeg' } }
        : {}),
    },
  } as unknown as ClassroomManifest;
  return { zip, manifest, slide };
}

describe('server-backed classroom ZIP import', () => {
  let stored: Map<string, { blob: Blob; meta: AssetMeta }>;

  beforeEach(() => {
    stored = new Map();
    mocks.serverBacked.mockReset().mockReturnValue(true);
    mocks.put.mockReset().mockImplementation(async (blob: Blob, meta: AssetMeta) => {
      const id = `ast_imported_${stored.size}`;
      stored.set(id, { blob, meta });
      return id;
    });
    mocks.mediaPut.mockReset().mockResolvedValue(undefined);
    mocks.audioPut.mockReset().mockResolvedValue(undefined);
  });

  it.each([false, true])(
    'stores every referenced byte before returning IDs (indexed poster: %s)',
    async (indexed) => {
      const { zip, manifest, slide } = archive(indexed);
      const audio = await materializeImportedAudio(zip, manifest, 'new-course', 2);
      const media = await materializeImportedMedia(zip, manifest, 'new-course', 2);
      const rewritten = rewriteImportedSlideMediaRefs(slide, media, audio.sourceRefToId);
      const image = rewritten.elements[0] as { src: string };
      const video = rewritten.elements[1] as { src: string; mediaRef: string; poster: string };
      const audioElement = rewritten.elements[2] as { src: string };
      const speech = {
        id: 'say',
        type: 'speech' as const,
        text: 'Hello',
        audioRef: 'audio/speech.mp3',
      };
      const actions = rewriteAudioRefsToIds([speech], audio.pathToId);
      expect(video.src).toBe(video.mediaRef);
      expect(actions[0]).toMatchObject({ audioId: audioElement.src });
      // Discarding the importing browser's cache must not discard the only copy.
      mocks.mediaPut.mockClear();
      mocks.audioPut.mockClear();
      for (const [ref, bytes, contentType] of [
        [image.src, 'image', 'image/png'],
        [video.src, 'video', 'video/mp4'],
        [video.poster, 'poster', 'image/jpeg'],
        [audioElement.src, 'narration', 'audio/mp3'],
      ]) {
        expect(ref).toMatch(/^ast_/);
        await expect(stored.get(ref)!.blob.text()).resolves.toBe(bytes);
        expect(stored.get(ref)!.meta.contentType).toBe(contentType);
      }
      expect(stored.size).toBe(4);
      expect(mocks.put).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.objectContaining({ contentType: 'audio/mp3', durationSeconds: 2 }),
        { stageId: 'new-course' },
      );
    },
  );

  it('finishes when the optional browser caches cannot be written', async () => {
    const { zip, manifest } = archive();
    mocks.audioPut.mockRejectedValue(new Error('browser cache full'));
    mocks.mediaPut.mockRejectedValue(new Error('browser cache full'));
    const audio = await materializeImportedAudio(zip, manifest, 'new-course', 2);
    const media = await materializeImportedMedia(zip, manifest, 'new-course', 2);
    expect(audio.pathToId.get('audio/speech.mp3')).toMatch(/^ast_/);
    expect(media.refToNewId.get('clip')).toMatch(/^ast_/);
    expect(stored.size).toBe(4);
  });

  it.each(['audio', 'media'] as const)(
    'propagates a failed %s upload without returning a local-only reference',
    async (kind) => {
      const { zip, manifest } = archive();
      const failure = new Error('asset endpoint unavailable');
      mocks.put.mockRejectedValue(failure);
      const materialize = kind === 'audio' ? materializeImportedAudio : materializeImportedMedia;
      const allocations: string[] = [];
      await expect(materialize(zip, manifest, 'new-course', 2, allocations)).rejects.toBe(failure);
      expect(allocations).toEqual([]);
      expect(mocks.audioPut).not.toHaveBeenCalled();
      expect(mocks.mediaPut).not.toHaveBeenCalled();
    },
  );

  it('waits for upload before writing the browser cache', async () => {
    const { zip, manifest } = archive();
    let finish!: (id: string) => void;
    mocks.put.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = materializeImportedAudio(zip, manifest, 'new-course', 2);
    await vi.waitFor(() => expect(mocks.put).toHaveBeenCalledOnce());
    expect(mocks.audioPut).not.toHaveBeenCalled();
    finish('ast_durable');
    const result = await pending;
    expect(result.pathToId.get('audio/speech.mp3')).toBe('ast_durable');
    expect(mocks.audioPut).toHaveBeenCalledWith(expect.objectContaining({ id: 'ast_durable' }));
  });

  it('does not allocate absent or explicitly missing ZIP entries', async () => {
    const { manifest } = archive();
    await materializeImportedAudio(new JSZip(), manifest, 'new-course', 2);
    await materializeImportedMedia(new JSZip(), manifest, 'new-course', 2);
    const { zip } = archive();
    for (const meta of Object.values(manifest.mediaIndex!)) meta.missing = true;
    await materializeImportedAudio(zip, manifest, 'new-course', 2);
    await materializeImportedMedia(zip, manifest, 'new-course', 2);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('keeps browser-only imports local, including cache failure behavior', async () => {
    mocks.serverBacked.mockReturnValue(false);
    const { zip, manifest } = archive();
    const audio = await materializeImportedAudio(zip, manifest, 'new-course', 2);
    const media = await materializeImportedMedia(zip, manifest, 'new-course', 2);
    expect(audio.pathToId.get('audio/speech.mp3')).not.toMatch(/^ast_/);
    expect(media.refToNewId.get('clip')).not.toMatch(/^ast_/);
    expect(mocks.put).not.toHaveBeenCalled();
    const failure = new Error('local storage full');
    mocks.audioPut.mockRejectedValue(failure);
    mocks.mediaPut.mockRejectedValue(failure);
    await expect(materializeImportedAudio(zip, manifest, 'new-course', 2)).rejects.toBe(failure);
    await expect(materializeImportedMedia(zip, manifest, 'new-course', 2)).rejects.toBe(failure);
  });

  it('serves imported bytes to an independent HTTP client with no importing-browser cache', async () => {
    const bytes = new Map<string, AssetBytes>();
    const backend: AssetStore = {
      async put(_principal, data, meta) {
        const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
        const id = toAssetId(`ast_http_${bytes.size}`);
        bytes.set(id, {
          bytes: new Uint8Array(await blob.arrayBuffer()),
          mime: meta?.contentType || blob.type,
          revision: 1,
        });
        return id;
      },
      async identify(_principal, ref) {
        const entry = bytes.get(ref);
        return entry
          ? { mime: entry.mime, revision: entry.revision, byteLength: entry.bytes.length }
          : null;
      },
      async resolve(_principal, ref) {
        return bytes.get(ref) ?? null;
      },
      async remove() {
        throw new Error('No client deletion is permitted');
      },
      async replace() {
        throw new Error('No client replacement is permitted');
      },
    };
    const server = createServer(
      createAssetHttpHandler(backend, {
        authenticate: async (req) =>
          req.headers.authorization === 'Bearer test-only'
            ? { key: 'shared-test-principal' }
            : undefined,
      }),
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = () => ({ authorization: 'Bearer test-only' });
    const writer = new HttpAssetStore({ baseUrl, headers });
    const reader = new HttpAssetStore({ baseUrl, headers });
    mocks.put.mockImplementation((blob: Blob, meta: AssetMeta) => writer.put(blob, meta));
    // The import succeeds even when this browser cannot retain a cache copy.
    mocks.audioPut.mockRejectedValue(new Error('cache unavailable'));
    mocks.mediaPut.mockRejectedValue(new Error('cache unavailable'));
    try {
      const { zip, manifest } = archive();
      const audio = await materializeImportedAudio(zip, manifest, 'new-course', 2);
      const media = await materializeImportedMedia(zip, manifest, 'new-course', 2);
      await writer.close();
      for (const [ref, expected] of [
        [audio.pathToId.get('audio/speech.mp3')!, 'narration'],
        [media.refToNewId.get('picture')!, 'image'],
        [media.refToNewId.get('clip')!, 'video'],
        [media.posterByMediaRef.get('clip')!, 'poster'],
      ]) {
        const url = await reader.resolve(ref);
        expect(url).not.toBeNull();
        try {
          await expect((await fetch(url!)).text()).resolves.toBe(expected);
        } finally {
          await reader.release(ref);
        }
      }
    } finally {
      await writer.close();
      await reader.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
