import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { KVScope } from '@openmaic/storage';
import JSZip from 'jszip';

import type { DocumentMigrationDeps } from '@/lib/document-store/migration';
import type { Scene, Stage } from '@/lib/types/stage';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';

// Round-trip coverage for the export snapshot seam: a persisted document that
// has never been converted still exports a ZIP whose manifest names the
// allocated ids and whose archive carries the media under exactly those ids --
// the access-first conversion and the in-memory snapshot conversion must agree
// on one reference set, and the ZIP must import back cleanly.
describe('classroom ZIP export conversion snapshot', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window);
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: 'visible',
      // The sonner toast module inserts its stylesheet at import time.
      head: { appendChild: vi.fn() },
      createElement: vi.fn(() => ({
        type: '',
        styleSheet: null,
        appendChild: vi.fn(),
      })),
      createTextNode: vi.fn(),
      getElementsByTagName: vi.fn(() => []),
    } as unknown as Document);
    vi.stubGlobal('location', { origin: 'http://localhost' });
    // jsZip reads Blob entries through FileReader, which Node lacks.
    vi.stubGlobal(
      'FileReader',
      class FileReaderStub {
        result: ArrayBuffer | null = null;
        onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;

        readAsArrayBuffer(blob: Blob): void {
          blob.arrayBuffer().then(
            (buffer) => {
              this.result = buffer;
              this.onload?.({ target: { result: buffer } });
            },
            (error) => this.onerror?.(error),
          );
        }
      } as unknown as typeof FileReader,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exports one consistent snapshot for an unconverted persisted document and imports back', async () => {
    const { db } = await import('@/lib/utils/database');
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const { BrowserDocumentStore } = await import('@openmaic/storage');
    const { buildClassroomExportZip } = await import('@/lib/export/use-export-classroom');
    const { materializeImportedAudio, materializeImportedMedia } =
      await import('@/lib/import/use-import-classroom');
    const { DSL_VERSION } = await import('@openmaic/dsl');
    const pool = getAssetPool();

    // The persisted document predates conversion: a gen_* placeholder and a
    // TTS-derived audioId, both backed by their legacy Dexie rows.
    const legacyScene = {
      id: 'scene-1',
      stageId: 'stage-1',
      type: 'slide',
      title: 'Scene',
      order: 0,
      content: {
        type: 'slide',
        canvas: {
          id: 'c1',
          elements: [{ id: 'el1', type: 'image', src: 'gen_img_1' }],
        },
      },
      actions: [{ id: 'a1', type: 'speech', text: 'Hi', audioId: 'tts_s0_a1' }],
    };
    const store = new BrowserDocumentStore({
      indexedDB: globalThis.indexedDB as unknown as IDBFactory,
      dbName: 'maic-documents',
      validateScene: () => ({ valid: true }),
    });
    await store.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Course', createdAt: 100, updatedAt: 200 },
      scenes: [legacyScene],
    } as never);
    await db.mediaFiles.put({
      id: 'stage-1:gen_img_1',
      stageId: 'stage-1',
      type: 'image',
      blob: new Blob(['image-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 11,
      prompt: 'a prompt',
      params: '{}',
      createdAt: 1,
    });
    await db.audioFiles.put({
      id: 'tts_s0_a1',
      stageId: 'stage-1',
      blob: new Blob(['audio-bytes'], { type: 'audio/mpeg' }),
      format: 'mp3',
      text: 'Hi',
      createdAt: 1,
    });
    // The in-memory working state mirrors the persisted document (the user's
    // copy is unconverted too; only the export access converts it).
    const stage = { id: 'stage-1', name: 'Course', createdAt: 100, updatedAt: 200 };
    const scenes = [legacyScene];

    const deps: DocumentMigrationDeps = {
      store,
      kv: new MemoryKv(),
      legacyStore: { read: async () => null, listStages: async () => [] },
      lockManager: lockManager(),
    };
    const { zip, fileName } = await buildClassroomExportZip(
      stage as Stage,
      scenes as Scene[],
      deps,
    );

    expect(fileName).toBe('Course.maic.zip');

    // The durable document was converted by the access-first step.
    const convertedDurable = await store.loadDocument('stage-1');
    const durableCanvas = (
      convertedDurable?.scenes[0].content as { canvas: { elements: { src: string }[] } }
    ).canvas;
    const durableAction = convertedDurable?.scenes[0].actions?.[0] as { audioId?: string };
    expect(durableCanvas.elements[0].src).toMatch(/^ast_/);
    expect(durableAction?.audioId).toMatch(/^ast_/);

    // The manifest names the SAME allocated ids the durable conversion chose,
    // never the legacy handles.
    const zipData = await JSZip.loadAsync(zip);
    const manifest = JSON.parse(
      await zipData.file('manifest.json')!.async('string'),
    ) as ClassroomManifest & {
      scenes: Array<{
        content: { canvas: { elements: { src: string }[] } };
        actions?: Array<{ audioRef?: string }>;
      }>;
    };
    const exportedSrc = manifest.scenes[0].content.canvas.elements[0].src;
    const exportedAudioRef = manifest.scenes[0].actions?.[0]?.audioRef;
    expect(exportedSrc).toBe(durableCanvas.elements[0].src);
    expect(exportedSrc).toMatch(/^ast_/);
    expect(exportedAudioRef).toBe('audio/audio-1.mp3');

    // The archive carries the media under exactly the manifest's references,
    // and the mediaIndex covers them (no dangling handles).
    expect(zipData.file('media/asset-1.png')).toBeDefined();
    expect(zipData.file(exportedAudioRef!)).toBeDefined();
    expect(manifest.mediaIndex?.['media/asset-1.png']).toMatchObject({
      type: 'generated',
      sourceRef: exportedSrc,
    });
    expect(manifest.mediaIndex?.[exportedAudioRef!]).toMatchObject({ type: 'audio' });

    // Round-trip: importing the ZIP materializes every entry into fresh
    // allocations that resolve, and the rewritten references are the new ids.
    const importedAllocations: string[] = [];
    const audioMappings = await materializeImportedAudio(
      zipData,
      manifest,
      'imported-1',
      Date.now(),
      importedAllocations,
    );
    const mediaMappings = await materializeImportedMedia(
      zipData,
      manifest,
      'imported-1',
      Date.now(),
      importedAllocations,
    );
    const importedMediaId = mediaMappings.refToNewId.get(exportedSrc);
    const importedAudioId = audioMappings.pathToId.get(exportedAudioRef!);
    expect(importedMediaId).toMatch(/^ast_/);
    expect(importedAudioId).toMatch(/^ast_/);
    expect(await pool.exists?.(importedMediaId as never)).toBe(true);
    expect(await pool.exists?.(importedAudioId as never)).toBe(true);
    expect(await db.mediaFiles.get(`imported-1:${importedMediaId}`)).toBeDefined();
    expect(await db.audioFiles.get(importedAudioId!)).toBeDefined();
  });

  it('round-trips one opaque ref independently as image media and speech audio', async () => {
    const { db } = await import('@/lib/utils/database');
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const { BrowserDocumentStore } = await import('@openmaic/storage');
    const { buildClassroomExportZip } = await import('@/lib/export/use-export-classroom');
    const { materializeImportedAudio, materializeImportedMedia, rewriteImportedSlideMediaRefs } =
      await import('@/lib/import/use-import-classroom');
    const { rewriteAudioRefsToIds } = await import('@/lib/export/classroom-zip-utils');
    const { DSL_VERSION } = await import('@openmaic/dsl');
    const pool = getAssetPool();
    const sharedRef = await pool.put(new Blob(['shared-bytes'], { type: 'image/png' }), {
      contentType: 'image/png',
      mediaType: 'image',
    });
    const slide = {
      id: 'slide-1',
      elements: [{ id: 'image-1', type: 'image', src: sharedRef }],
    };
    const scene = {
      id: 'scene-1',
      stageId: 'stage-1',
      type: 'slide',
      title: 'Scene',
      order: 0,
      content: { type: 'slide', canvas: slide },
      actions: [{ id: 'speech-1', type: 'speech', text: 'Shared', audioId: sharedRef }],
    };
    const stage = { id: 'stage-1', name: 'Course', createdAt: 100, updatedAt: 200 };
    const store = new BrowserDocumentStore({
      indexedDB: globalThis.indexedDB as unknown as IDBFactory,
      dbName: 'maic-documents',
      validateScene: () => ({ valid: true }),
    });
    await store.saveDocument({ dslVersion: DSL_VERSION, stage, scenes: [scene] } as never);
    await db.mediaFiles.put({
      id: `stage-1:${sharedRef}`,
      stageId: 'stage-1',
      type: 'image',
      blob: new Blob(['image-row'], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 9,
      prompt: '',
      params: '',
      createdAt: 1,
    });
    await db.audioFiles.put({
      id: sharedRef,
      stageId: 'stage-1',
      blob: new Blob(['audio-row'], { type: 'audio/mpeg' }),
      format: 'mp3',
      duration: 1,
      createdAt: 1,
    });

    const { zip } = await buildClassroomExportZip(stage as Stage, [scene] as Scene[], {
      store,
      kv: new MemoryKv(),
      legacyStore: { read: async () => null, listStages: async () => [] },
      lockManager: lockManager(),
    });
    const zipData = await JSZip.loadAsync(zip);
    const manifest = JSON.parse(
      await zipData.file('manifest.json')!.async('string'),
    ) as ClassroomManifest;
    const mediaPath = 'media/asset-1.png';
    const audioPath = 'audio/audio-1.mp3';
    expect(zipData.file(mediaPath)).toBeDefined();
    expect(zipData.file(audioPath)).toBeDefined();
    expect(manifest.mediaIndex?.[mediaPath]).toMatchObject({
      type: 'generated',
      sourceRef: sharedRef,
    });
    expect(manifest.mediaIndex?.[audioPath]).toMatchObject({
      type: 'audio',
      sourceRef: sharedRef,
    });
    expect(manifest.scenes[0].actions?.[0]).toMatchObject({ audioRef: audioPath });

    const audioMappings = await materializeImportedAudio(
      zipData,
      manifest,
      'imported-cross-kind',
      Date.now(),
    );
    const mediaMappings = await materializeImportedMedia(
      zipData,
      manifest,
      'imported-cross-kind',
      Date.now(),
    );
    const exportedContent = manifest.scenes[0].content;
    if (exportedContent.type !== 'slide') throw new Error('expected slide content');
    const importedSlide = rewriteImportedSlideMediaRefs(exportedContent.canvas, mediaMappings);
    const importedActions = rewriteAudioRefsToIds(
      manifest.scenes[0].actions ?? [],
      audioMappings.pathToId,
    );
    const importedMediaId = mediaMappings.refToNewId.get(sharedRef);
    const importedAudioId = audioMappings.pathToId.get(audioPath);
    expect(importedMediaId).toMatch(/^ast_/);
    expect(importedAudioId).toMatch(/^ast_/);
    expect(importedMediaId).not.toBe(importedAudioId);
    expect(importedSlide.elements[0]).toMatchObject({ src: importedMediaId });
    expect(importedActions[0]).toMatchObject({ audioId: importedAudioId });
  });

  it('round-trips pool-backed slide audio through the classroom ZIP', async () => {
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const { BrowserDocumentStore } = await import('@openmaic/storage');
    const { buildClassroomExportZip } = await import('@/lib/export/use-export-classroom');
    const { materializeImportedAudio, rewriteImportedSlideMediaRefs } =
      await import('@/lib/import/use-import-classroom');
    const { DSL_VERSION } = await import('@openmaic/dsl');
    const pool = getAssetPool();
    const sourceAudioId = await pool.put(new Blob(['slide-audio-bytes'], { type: 'audio/mpeg' }), {
      contentType: 'audio/mpeg',
      mediaType: 'audio',
    });
    const slide = {
      id: 'slide-1',
      elements: [{ id: 'audio-1', type: 'audio', src: sourceAudioId }],
    };
    const scene = {
      id: 'scene-1',
      stageId: 'stage-1',
      type: 'slide',
      title: 'Scene',
      order: 0,
      content: { type: 'slide', canvas: slide },
    };
    const stage = { id: 'stage-1', name: 'Course', createdAt: 100, updatedAt: 200 };
    const store = new BrowserDocumentStore({
      indexedDB: globalThis.indexedDB as unknown as IDBFactory,
      dbName: 'maic-documents',
      validateScene: () => ({ valid: true }),
    });
    await store.saveDocument({
      dslVersion: DSL_VERSION,
      stage,
      scenes: [scene],
    } as never);

    const { zip } = await buildClassroomExportZip(stage as Stage, [scene] as Scene[], {
      store,
      kv: new MemoryKv(),
      legacyStore: { read: async () => null, listStages: async () => [] },
      lockManager: lockManager(),
    });
    const zipData = await JSZip.loadAsync(zip);
    const manifest = JSON.parse(
      await zipData.file('manifest.json')!.async('string'),
    ) as ClassroomManifest;
    const audioPath = 'audio/audio-1.mp3';
    expect(zipData.file(audioPath)).toBeDefined();
    expect(await zipData.file(audioPath)!.async('string')).toBe('slide-audio-bytes');
    expect(manifest.mediaIndex?.[audioPath]).toMatchObject({ type: 'audio' });

    const audioMappings = await materializeImportedAudio(
      zipData,
      manifest,
      'imported-1',
      Date.now(),
    );
    const exportedContent = manifest.scenes[0].content;
    expect(exportedContent.type).toBe('slide');
    if (exportedContent.type !== 'slide') throw new Error('expected exported slide content');
    const importedSlide = rewriteImportedSlideMediaRefs(
      exportedContent.canvas,
      { refToNewId: new Map(), posterRefToNewId: new Map(), posterByMediaRef: new Map() },
      audioMappings.sourceRefToId,
    );
    const importedAudioId = audioMappings.sourceRefToId.get(sourceAudioId);
    expect(importedAudioId).toMatch(/^ast_/);
    expect(importedAudioId).not.toBe(sourceAudioId);
    expect(importedSlide.elements[0]).toMatchObject({ type: 'audio', src: importedAudioId });
    expect(await pool.exists?.(importedAudioId as never)).toBe(true);
  });

  it('does not archive stage-whiteboard bytes the classroom format cannot reconstruct', async () => {
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const { BrowserDocumentStore } = await import('@openmaic/storage');
    const { buildClassroomExportZip } = await import('@/lib/export/use-export-classroom');
    const { DSL_VERSION } = await import('@openmaic/dsl');
    const pool = getAssetPool();
    const whiteboardAssetId = await pool.put(
      new Blob(['stage-whiteboard-bytes'], { type: 'image/png' }),
      { contentType: 'image/png', mediaType: 'image' },
    );
    const stage = {
      id: 'stage-1',
      name: 'Course',
      createdAt: 100,
      updatedAt: 200,
      whiteboard: [
        {
          id: 'stage-whiteboard',
          elements: [{ id: 'whiteboard-image', type: 'image', src: whiteboardAssetId }],
        },
      ],
    };
    const store = new BrowserDocumentStore({
      indexedDB: globalThis.indexedDB as unknown as IDBFactory,
      dbName: 'maic-documents',
      validateScene: () => ({ valid: true }),
    });
    await store.saveDocument({ dslVersion: DSL_VERSION, stage, scenes: [] } as never);

    const { zip } = await buildClassroomExportZip(stage as Stage, [], {
      store,
      kv: new MemoryKv(),
      legacyStore: { read: async () => null, listStages: async () => [] },
      lockManager: lockManager(),
    });
    const zipData = await JSZip.loadAsync(zip);
    const manifest = JSON.parse(
      await zipData.file('manifest.json')!.async('string'),
    ) as ClassroomManifest;

    expect(manifest.stage).not.toHaveProperty('whiteboard');
    expect(Object.values(manifest.mediaIndex)).not.toContainEqual(
      expect.objectContaining({ sourceRef: whiteboardAssetId }),
    );
  });

  it('keeps unsaved scene edits while converting their references', async () => {
    // The working state may carry edits that never reached the document; the
    // export snapshot must keep them while rewriting their media references.
    const { db } = await import('@/lib/utils/database');
    const { BrowserDocumentStore } = await import('@openmaic/storage');
    const { buildClassroomExportZip } = await import('@/lib/export/use-export-classroom');
    const { DSL_VERSION } = await import('@openmaic/dsl');
    const store = new BrowserDocumentStore({
      indexedDB: globalThis.indexedDB as unknown as IDBFactory,
      dbName: 'maic-documents',
      validateScene: () => ({ valid: true }),
    });
    await store.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Course', createdAt: 100, updatedAt: 200 },
      scenes: [],
    } as never);
    await db.mediaFiles.put({
      id: 'stage-1:gen_img_1',
      stageId: 'stage-1',
      type: 'image',
      blob: new Blob(['image-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 11,
      prompt: 'a prompt',
      params: '{}',
      createdAt: 1,
    });
    // The durable document is empty, but the working state has an edited
    // scene the user has not saved yet.
    const stage = { id: 'stage-1', name: 'Course', createdAt: 100, updatedAt: 200 };
    const editedScene = {
      id: 'scene-1',
      stageId: 'stage-1',
      type: 'slide',
      title: 'Edited title',
      order: 0,
      content: {
        type: 'slide',
        canvas: {
          id: 'c1',
          elements: [{ id: 'el1', type: 'image', src: 'gen_img_1' }],
        },
      },
    };

    const { zip } = await buildClassroomExportZip(stage as Stage, [editedScene] as Scene[], {
      store,
      kv: new MemoryKv(),
      legacyStore: { read: async () => null, listStages: async () => [] },
      lockManager: lockManager(),
    });

    const zipData = await JSZip.loadAsync(zip);
    const manifest = JSON.parse(await zipData.file('manifest.json')!.async('string')) as {
      scenes: Array<{ title: string; content: { canvas: { elements: { src: string }[] } } }>;
      mediaIndex: Record<string, unknown>;
    };
    // The unsaved edit survives, with its media reference converted.
    expect(manifest.scenes[0].title).toBe('Edited title');
    const exportedSrc = manifest.scenes[0].content.canvas.elements[0].src;
    expect(exportedSrc).toMatch(/^ast_/);
    expect(zipData.file('media/asset-1.png')).toBeDefined();
  });

  it('a successful export leaves no new pool entries or mirror rows behind', async () => {
    // Finding: the export snapshot conversion allocates pool entries + mirror
    // rows into a ledger, but only the conversion-error branch rolled them
    // back. A successful export discards the snapshot without persisting it,
    // leaving the allocations unowned. The durable document was converted
    // FIRST, so a fresh allocation can only belong to the ephemeral snapshot:
    // once the ZIP has captured its bytes (or the export fails), the ledger
    // entries the durable document does not reference must be rolled back.
    const { db } = await import('@/lib/utils/database');
    const { getAssetPool } = await import('@/lib/media/asset-pool');
    const { BrowserDocumentStore } = await import('@openmaic/storage');
    const { buildClassroomExportZip } = await import('@/lib/export/use-export-classroom');
    const { DSL_VERSION } = await import('@openmaic/dsl');
    const pool = getAssetPool();

    // The durable document is FULLY converted: allocated media + audio ids,
    // each backed by pool bytes and a compatibility row.
    const mediaId = await pool.put(new Blob(['media-bytes'], { type: 'image/png' }), {
      contentType: 'image/png',
      mediaType: 'image',
      origin: 'legacy-mediaFiles',
    });
    const audioId = await pool.put(new Blob(['audio-bytes'], { type: 'audio/mpeg' }), {
      contentType: 'audio/mpeg',
      mediaType: 'audio',
      origin: 'legacy-audioFiles',
    });
    const durableScene = {
      id: 'scene-1',
      stageId: 'stage-1',
      type: 'slide',
      title: 'Scene',
      order: 0,
      content: {
        type: 'slide',
        canvas: {
          id: 'c1',
          elements: [{ id: 'el1', type: 'image', src: mediaId }],
        },
      },
      actions: [{ id: 'a1', type: 'speech', text: 'Hi', audioId }],
    };
    const store = new BrowserDocumentStore({
      indexedDB: globalThis.indexedDB as unknown as IDBFactory,
      dbName: 'maic-documents',
      validateScene: () => ({ valid: true }),
    });
    await store.saveDocument({
      dslVersion: DSL_VERSION,
      stage: { id: 'stage-1', name: 'Course', createdAt: 100, updatedAt: 200 },
      scenes: [durableScene],
    } as never);
    await db.mediaFiles.put({
      id: `stage-1:${mediaId}`,
      stageId: 'stage-1',
      type: 'image',
      blob: new Blob(['media-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 11,
      prompt: 'a prompt',
      params: '{}',
      createdAt: 1,
      placeholderRef: 'gen_img_1',
    });
    await db.audioFiles.put({
      id: audioId,
      stageId: 'stage-1',
      blob: new Blob(['audio-bytes'], { type: 'audio/mpeg' }),
      format: 'mp3',
      text: 'Hi',
      createdAt: 1,
      originAudioId: 'tts_s0_a1',
    });

    // The working state carries an unsaved edit the durable document never
    // saw: a NEW legacy placeholder only the export snapshot conversion will
    // allocate for.
    const workingScenes = [
      {
        ...durableScene,
        content: {
          type: 'slide',
          canvas: {
            id: 'c1',
            elements: [
              { id: 'el1', type: 'image', src: mediaId },
              { id: 'el2', type: 'image', src: 'gen_img_new' },
            ],
          },
        },
      },
    ];
    await db.mediaFiles.put({
      id: 'stage-1:gen_img_new',
      stageId: 'stage-1',
      type: 'image',
      blob: new Blob(['new-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 9,
      prompt: 'new',
      params: '{}',
      createdAt: 2,
    });

    const deps: DocumentMigrationDeps = {
      store,
      kv: new MemoryKv(),
      legacyStore: { read: async () => null, listStages: async () => [] },
      lockManager: lockManager(),
    };
    const stage = { id: 'stage-1', name: 'Course', createdAt: 100, updatedAt: 200 };
    const { zip } = await buildClassroomExportZip(stage as Stage, workingScenes as Scene[], deps);

    // The export snapshot's fresh allocation reached the ZIP (the archive is
    // self-contained)...
    const zipData = await JSZip.loadAsync(zip);
    const manifest = JSON.parse(await zipData.file('manifest.json')!.async('string')) as {
      scenes: Array<{ content: { canvas: { elements: { src: string }[] } } }>;
    };
    const exportedNewSrc = manifest.scenes[0].content.canvas.elements[1].src;
    expect(exportedNewSrc).toMatch(/^ast_/);
    expect(zipData.file('media/asset-1.png')).toBeDefined();

    // ...but its pool entry and compatibility mirror row were rolled back
    // once the ZIP captured the bytes: the durable document never referenced
    // them, so nothing may retain them.
    expect(await pool.exists?.(exportedNewSrc as never)).toBe(false);
    expect(await db.mediaFiles.get(`stage-1:${exportedNewSrc}`)).toBeUndefined();

    // The durable document's own allocations are untouched.
    expect(await pool.exists?.(mediaId as never)).toBe(true);
    expect(await pool.exists?.(audioId as never)).toBe(true);
    expect(await db.mediaFiles.get(`stage-1:${mediaId}`)).toBeDefined();
    expect(await db.audioFiles.get(audioId)).toBeDefined();
    const durable = await store.loadDocument('stage-1');
    const durableCanvas = (
      durable?.scenes[0].content as unknown as { canvas: { elements: unknown[] } }
    ).canvas;
    expect(durableCanvas.elements).toHaveLength(1);
  });
});

class MemoryKv {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string, scope: KVScope = 'account'): Promise<T | null> {
    return (this.values.get(`${scope}:${key}`) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T, scope: KVScope = 'account'): Promise<void> {
    this.values.set(`${scope}:${key}`, structuredClone(value));
  }

  async remove(key: string, scope: KVScope = 'account'): Promise<void> {
    this.values.delete(`${scope}:${key}`);
  }

  async keys(prefix = '', scope: KVScope = 'account'): Promise<string[]> {
    const fullPrefix = `${scope}:${prefix}`;
    return [...this.values.keys()]
      .filter((key) => key.startsWith(fullPrefix))
      .map((key) => key.slice(scope.length + 1));
  }
}

function lockManager(): LockManager {
  let tail = Promise.resolve();
  return {
    request: vi.fn((_name, _options, callback) => {
      const result = tail.then(() => callback({ name: _name, mode: 'exclusive' } as Lock));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }),
    query: vi.fn(),
  } as unknown as LockManager;
}
