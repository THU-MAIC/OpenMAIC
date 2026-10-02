/**
 * Browsers that last ran an old build, and courses from earlier opt-in server
 * builds, through the importer.
 *
 * The old database is written at schema version 5 (before generated-media rows
 * were keyed by course, before the `language` field became
 * `languageDirective`); opening it for the import runs Dexie's own upgrade
 * steps, which the legacy schema keeps verbatim.
 */
import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/device-storage/database';
import { runLegacyBrowserImport } from '@/lib/legacy-browser-import';
import { LegacyBrowserDatabase, type SceneRecord } from '@/lib/legacy-browser-storage/schema';

import {
  FakeServer,
  MemoryStorage,
  NOW,
  OWNER_A,
  configureSeams,
  course,
  freshBrowser,
  seedDocumentsStore,
  slideScene,
} from './harness';

let storage: MemoryStorage;
let server: FakeServer;
let teardown: () => Promise<void>;

beforeEach(async () => {
  await freshBrowser();
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage }));
  server = new FakeServer();
  teardown = await configureSeams(server);
});

afterEach(async () => {
  await teardown();
  vi.unstubAllGlobals();
});

async function bytes(blob: Blob | undefined): Promise<string> {
  return blob ? Buffer.from(await blob.arrayBuffer()).toString() : '<none>';
}

/** `MAIC-Database` as a version-5 build declared it. */
class Version5Database extends Dexie {
  constructor() {
    super('MAIC-Database');
    const v1 = {
      stages: 'id, updatedAt',
      scenes: 'id, stageId, order, [stageId+order]',
      audioFiles: 'id, createdAt',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
    };
    this.version(1).stores(v1);
    this.version(2).stores({
      ...v1,
      messages: null,
      participants: null,
      discussions: null,
      sceneSnapshots: null,
    });
    const v3 = {
      ...v1,
      chatSessions: 'id, stageId, [stageId+createdAt]',
      playbackState: 'stageId',
    };
    this.version(3).stores(v3);
    this.version(4).stores({ ...v3, stageOutlines: 'stageId' });
    this.version(5).stores({
      ...v3,
      stageOutlines: 'stageId',
      mediaFiles: 'id, stageId, [stageId+type]',
    });
  }
}

describe('a browser that last ran a version-5 build', () => {
  it('opens through the upgrade ladder and imports the course with its media', async () => {
    const old = new Version5Database();
    const scene = slideScene('old-course', {
      id: 'old-scene',
      order: 0,
      imageRef: 'gen_img_1',
      audioIds: [{ id: 'action_oldaction1', audioId: 'tts_s0_action_oldaction1', text: 'Old' }],
    });
    await old.table('stages').put({
      id: 'old-course',
      name: 'Old course',
      language: 'zh-CN',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await old.table('scenes').put(scene);
    // Before version 6, generated-media rows were keyed by element id alone.
    await old.table('mediaFiles').put({
      id: 'gen_img_1',
      stageId: 'old-course',
      type: 'image',
      blob: new Blob(['old-image'], { type: 'image/png' }),
      mimeType: 'image/png',
      size: 9,
      prompt: 'old',
      params: '{}',
      createdAt: NOW,
    });
    await old.table('audioFiles').put({
      id: 'tts_s0_action_oldaction1',
      blob: new Blob(['old-voice'], { type: 'audio/mpeg' }),
      format: 'mp3',
      createdAt: NOW,
    });
    old.close();

    const outcome = await runLegacyBrowserImport(server.options(storage));

    expect(outcome.status).toBe('complete');
    const imported = (await server.rawDocument('old-course'))!;
    // Version 9's upgrade turned the locale into a directive.
    expect(imported.stage).toMatchObject({
      name: 'Old course',
      languageDirective: 'Deliver the entire course in Chinese (Simplified, zh-CN).',
    });
    expect(imported.stage).not.toHaveProperty('language');
    const canvas = (imported.scenes[0]!.content as { canvas: { elements: { src: string }[] } })
      .canvas;
    const imageRef = canvas.elements[0]!.src;
    expect(await bytes(server.assets.get(imageRef)?.blob)).toBe('old-image');
    const audioId = (imported.scenes[0]!.actions![0] as { audioId: string }).audioId;
    expect(await bytes(server.assets.get(audioId)?.blob)).toBe('old-voice');

    // Version 6's upgrade re-keyed the media row by course, as the importer read it.
    const legacy = new LegacyBrowserDatabase();
    expect(await legacy.mediaFiles.get('old-course:gen_img_1')).toBeDefined();
    legacy.close();
  });
});

describe('server courses from an earlier opt-in server build', () => {
  it('uploads bytes that only the old tables hold and copies device-only rows', async () => {
    // The course is on the server only; the browser has no copy of it, just
    // the narration it could not upload and a refusal record.
    await server.seedDocument(
      course('server-course', [
        {
          id: 'server-scene',
          order: 0,
          imageRef: 'gen_img_7',
          audioIds: [{ id: 'action_serveract1', audioId: 'tts_s0_action_serveract1', text: 'Hi' }],
        },
      ]),
    );
    const legacy = new LegacyBrowserDatabase();
    await legacy.audioFiles.put({
      id: 'tts_s0_action_serveract1',
      stageId: 'server-course',
      blob: new Blob(['refused-narration'], { type: 'audio/mpeg' }),
      format: 'mp3',
      createdAt: NOW,
    });
    await legacy.mediaFiles.put({
      id: 'server-course:gen_img_7',
      stageId: 'server-course',
      type: 'image',
      blob: new Blob([]),
      mimeType: 'image/png',
      size: 0,
      prompt: 'refused',
      params: '{}',
      error: 'refused',
      errorCode: 'CONTENT_SENSITIVE',
      createdAt: NOW,
    });
    await legacy.autoVoiceCache.put({
      voiceId: 'voice-9',
      referenceAudio: new Blob(['clip']),
      mimeType: 'audio/wav',
      updatedAt: NOW,
    });
    legacy.close();

    const outcome = await runLegacyBrowserImport(server.options(storage));

    expect(outcome.status).toBe('complete');
    expect(outcome.ledger?.courses['server-course']).toMatchObject({
      status: 'done',
      origin: 'existing',
    });
    const after = (await server.rawDocument('server-course'))!;
    const audioId = (after.scenes[0]!.actions![0] as { audioId: string }).audioId;
    expect(audioId).toMatch(/^ast_server/);
    expect(await bytes(server.assets.get(audioId)?.blob)).toBe('refused-narration');
    // The refused element keeps its placeholder, and its record keeps the
    // refusal.
    expect(await db.mediaFiles.get('server-course:gen_img_7')).toMatchObject({
      errorCode: 'CONTENT_SENSITIVE',
    });
    expect(await db.autoVoiceCache.get('voice-9')).toBeDefined();
  });

  it('keeps the device row newer than the legacy copy', async () => {
    await server.seedDocument(
      course('server-course', [{ id: 's', order: 0, imageRef: 'gen_img_1' }]),
    );
    const legacy = new LegacyBrowserDatabase();
    await legacy.mediaFiles.put({
      id: 'server-course:gen_img_1',
      stageId: 'server-course',
      type: 'image',
      blob: new Blob([]),
      mimeType: 'image/png',
      size: 0,
      prompt: 'old',
      params: '{}',
      error: 'old refusal',
      errorCode: 'CONTENT_SENSITIVE',
      createdAt: NOW,
    });
    legacy.close();
    await db.mediaFiles.put({
      id: 'server-course:gen_img_1',
      stageId: 'server-course',
      type: 'image',
      blob: new Blob([]),
      mimeType: 'image/png',
      size: 0,
      prompt: 'new',
      params: '{}',
      error: 'newer',
      errorCode: 'GENERATION_FAILED',
      createdAt: NOW + 1,
    });

    await runLegacyBrowserImport(server.options(storage));

    expect(await db.mediaFiles.get('server-course:gen_img_1')).toMatchObject({ error: 'newer' });
  });
});

describe('pre-runtime quiz keys', () => {
  it('skips quiz state whose scene id two legacy courses share', async () => {
    // A duplicated course: the document store keeps scenes per course, so
    // both hold the same scene id.
    await seedDocumentsStore([
      course('course-one', [{ id: 'shared-quiz', order: 0 }]),
      course('course-copy', [{ id: 'shared-quiz', order: 0 }]),
    ]);
    storage.setItem('quizAnswers:shared-quiz', JSON.stringify({ q1: 'A' }));
    const logged: string[] = [];

    const outcome = await runLegacyBrowserImport(
      server.options(storage, { log: (message: string) => logged.push(message) }),
    );

    expect(outcome.status).toBe('complete');
    for (const stageId of ['course-one', 'course-copy']) {
      expect(
        (await server.rawSessions(stageId)).filter((session) => session.kind === 'quizAttempt'),
      ).toEqual([]);
    }
    expect(logged.some((line) => line.includes('ambiguous'))).toBe(true);
    // The keys stay for the regular load path, which still owns them.
    expect(storage.getItem('quizAnswers:shared-quiz')).not.toBeNull();
  });
});

describe('folders', () => {
  it('leaves courses unfiled when the owner is at the folder limit', async () => {
    const legacy = new LegacyBrowserDatabase();
    await legacy.stages.put({ id: 'filed', name: 'Filed', createdAt: NOW, updatedAt: NOW });
    await legacy.scenes.put(slideScene('filed', { id: 'f', order: 0 }) as unknown as SceneRecord);
    await legacy.folders.put({ id: 'f1', name: 'Full', order: 0, createdAt: NOW, updatedAt: NOW });
    await legacy.stageFolders.put({ stageId: 'filed', folderId: 'f1', updatedAt: NOW });
    legacy.close();
    server.folderLimit = 0;

    const outcome = await runLegacyBrowserImport(server.options(storage));

    expect(outcome.status).toBe('complete');
    expect(outcome.ledger?.folders.f1).toMatchObject({ status: 'failed', reason: 'folder limit' });
    expect(outcome.ledger?.courses.filed?.status).toBe('done');
    expect(server.membership.has('filed')).toBe(false);
  });

  it('reuses a folder of the same name and files an unfiled server course into it', async () => {
    await server.folderApi.create('Physics');
    await server.seedDocument(course('synced', [{ id: 's', order: 0 }]));
    const legacy = new LegacyBrowserDatabase();
    await legacy.stages.put({ id: 'synced', name: 'Synced', createdAt: NOW, updatedAt: NOW });
    await legacy.scenes.put(slideScene('synced', { id: 's', order: 0 }) as unknown as SceneRecord);
    await legacy.folders.put({
      id: 'lf',
      name: 'Physics',
      order: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await legacy.stageFolders.put({ stageId: 'synced', folderId: 'lf', updatedAt: NOW });
    legacy.close();

    await runLegacyBrowserImport(server.options(storage));

    expect(server.folders.get(OWNER_A)).toHaveLength(1);
    expect(server.membership.get('synced')).toBe(server.folders.get(OWNER_A)![0]!.id);
  });
});
