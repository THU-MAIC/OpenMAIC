/**
 * Ownership handoff, tabs without Web Locks, refused media, singleton runtime
 * kinds, and the guards whose mutations the first review found uncovered.
 */
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/device-storage/database';
import { runLegacyBrowserImport } from '@/lib/legacy-browser-import';
import { isRetryableMediaFailure } from '@/lib/media/media-failure';
import { freshStageId } from '@/lib/legacy-browser-import/ids';
import { LEDGER_KEY, loadLedger } from '@/lib/legacy-browser-import/ledger';
import { readLegacyCourse, type LegacySources } from '@/lib/legacy-browser-import/sources';
import { LegacyBrowserDatabase, type SceneRecord } from '@/lib/legacy-browser-storage/schema';

import {
  FakeServer,
  ISO,
  LEGACY_LEARNER,
  MemoryStorage,
  NOW,
  OWNER_A,
  configureSeams,
  course,
  dumpLegacyDatabases,
  freshBrowser,
  seedAssetPool,
  seedDocumentsStore,
  seedLegacyLearnerKey,
  seedRuntimeStore,
  slideScene,
} from './harness';
import { DOCS_COURSE, TABLES_COURSE, seedLatestBrowser } from './fixtures';

const OWNER_C = 'anon:cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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

const at = (time: number) => server.options(storage, { now: () => time });
const httpError = (status: number, code: string) =>
  Object.assign(new Error(code), { status, code });

function speechIds(document: { scenes: { actions?: unknown[] }[] }): string[] {
  return document.scenes.flatMap((scene) =>
    (scene.actions ?? []).map((action) => (action as { audioId?: string }).audioId ?? ''),
  );
}

describe('the ledger holds no owner id', () => {
  it('stores only a digest of the owner, under one browser-wide key', async () => {
    await seedLatestBrowser(storage);
    await runLegacyBrowserImport(server.options(storage));
    const uuid = OWNER_A.slice('anon:'.length);
    for (const [key, value] of storage.values) {
      expect(key).not.toContain(uuid);
      expect(value).not.toContain(uuid);
    }
    expect(loadLedger(storage)?.ownerDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      [...storage.values.keys()].filter((key) => key.startsWith('maic:legacy-import')),
    ).toEqual([LEDGER_KEY]);
  });
});

describe('two tabs without Web Locks', () => {
  it('does not duplicate a course another tab imported since this tab listed the library', async () => {
    await seedLatestBrowser(storage);
    const before = storage.getItem(LEDGER_KEY);
    // Tab A creates the ledger (and its salt) and imports everything.
    const tabA = await runLegacyBrowserImport(server.options(storage));
    expect(tabA.status).toBe('complete');
    const ownedByA = [...server.stageOwners.keys()].sort();

    // Tab B started at the same time: it saw the ledger as it was when both
    // began (same salt, nothing done) and listed the library before A saved.
    const started = JSON.parse(storage.getItem(LEDGER_KEY)!) as Record<string, unknown>;
    expect(before).toBeNull();
    storage.setItem(
      LEDGER_KEY,
      JSON.stringify({ ...started, courses: {}, folders: {}, completedAt: undefined }),
    );
    let listings = 0;
    const stale = server.listOwnedStages;
    const tabB = await runLegacyBrowserImport(
      server.options(storage, {
        listOwnedStages: async () => (++listings === 1 ? [] : stale()),
      }),
    );

    expect(tabB.status).not.toBe('unavailable');
    expect([...server.stageOwners.keys()].sort()).toEqual(ownedByA);
    expect(server.folders.get(OWNER_A)).toHaveLength(2);
  });
});

describe('media the server refuses for good', () => {
  it('puts the element into the failed-media state instead of a dangling reference', async () => {
    const [poolId] = await seedAssetPool([new Blob(['huge-video'], { type: 'video/mp4' })]);
    await seedDocumentsStore([
      course('big-course', [{ id: 'big-scene', order: 0, videoRef: poolId }]),
    ]);
    const legacyBefore = await dumpLegacyDatabases();
    server.failWith = (operation) =>
      operation === 'putAsset' ? httpError(413, 'PAYLOAD_TOO_LARGE') : undefined;

    const outcome = await runLegacyBrowserImport(server.options(storage));

    expect(outcome.status).toBe('complete');
    expect(outcome.ledger?.courses['big-course']?.media?.[poolId!]).toMatchObject({
      status: 'failed',
      reason: '413 PAYLOAD_TOO_LARGE',
    });
    // The same record the media pass writes for a failure: the element shows
    // as failed (with its Retry), not as a silent blank.
    expect(await db.mediaFiles.get(`big-course:${poolId}`)).toMatchObject({
      stageId: 'big-course',
      type: 'video',
      placeholderRef: poolId,
      // A user's own media has no generation request: failed, without Retry.
      errorCode: 'ASSET_REFUSED',
      size: 0,
    });
    expect(isRetryableMediaFailure({ errorCode: 'ASSET_REFUSED' })).toBe(false);
    expect(await dumpLegacyDatabases()).toEqual(legacyBefore);
  });
});

describe('runtime sessions the server already has', () => {
  it('does not create a second active whiteboard session', async () => {
    await seedLatestBrowser(storage);
    let failed = false;
    server.failWith = (operation, subject) => {
      if (operation === 'createSession' && subject.startsWith('whiteboard:') && !failed) {
        failed = true;
        return httpError(503, 'UNAVAILABLE');
      }
      return undefined;
    };
    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.status).toBe('pending');

    // The learner opens the course and draws: the app creates its session.
    await server.seedSession({
      id: `whiteboard:${DOCS_COURSE}:${encodeURIComponent(OWNER_A)}`,
      kind: 'whiteboard',
      stageId: DOCS_COURSE,
      learnerKey: OWNER_A,
      status: 'active',
      createdAt: ISO,
      updatedAt: ISO,
    });
    await runLegacyBrowserImport(at(first.ledger!.nextRunAt!));

    const active = (await server.rawSessions(DOCS_COURSE)).filter(
      (session) => session.kind === 'whiteboard' && session.status === 'active',
    );
    expect(active.map((session) => session.id)).toEqual([
      `whiteboard:${DOCS_COURSE}:${encodeURIComponent(OWNER_A)}`,
    ]);
  });

  it('leaves a session the app wrote under a legacy session id alone', async () => {
    await seedLatestBrowser(storage);
    const legacyId = `quiz-attempt:${DOCS_COURSE}:docs-scene-3:${encodeURIComponent(LEGACY_LEARNER)}`;
    await server.seedSession(
      {
        id: legacyId,
        kind: 'quizAttempt',
        stageId: DOCS_COURSE,
        learnerKey: OWNER_A,
        status: 'active',
        createdAt: ISO,
        updatedAt: ISO,
      },
      [
        {
          id: 'server-record',
          sceneId: 'docs-scene-3',
          createdAt: ISO,
          payload: { payloadVersion: 1, phase: 'draft', answers: { q1: 'Z' } },
        },
      ],
    );

    await runLegacyBrowserImport(server.options(storage));

    const records = await server.rawRecords(legacyId);
    expect(records.map((record) => record.id)).toEqual(['server-record']);
  });

  it('carries the course id inside chat restore markers of a fresh-id course', async () => {
    const chatId = `chat:marked:${encodeURIComponent(LEGACY_LEARNER)}:chat-9`;
    const markerId = `chat-restore-marker:marked:${encodeURIComponent(LEGACY_LEARNER)}:m1`;
    await seedDocumentsStore([course('marked', [{ id: 'marked-scene', order: 0 }])]);
    seedLegacyLearnerKey(storage);
    await seedRuntimeStore([
      {
        init: {
          id: markerId,
          kind: 'chat',
          stageId: 'marked',
          learnerKey: LEGACY_LEARNER,
          status: 'active',
          createdAt: ISO,
          updatedAt: ISO,
        },
        records: [
          {
            id: `${markerId}:targets`,
            createdAt: ISO,
            payload: {
              role: 'system',
              content: '',
              kind: 'chat_restore_marker',
              runtimeSessionIds: [chatId],
            },
          },
        ],
        status: 'completed',
      },
    ]);
    await server.seedDocument(course('marked', [{ id: 'theirs', order: 0 }]), OWNER_C);

    const outcome = await runLegacyBrowserImport(server.options(storage));

    const fresh = freshStageId('marked', outcome.ledger!.salt);
    const [marker] = await server.rawSessions(fresh);
    expect(marker!.id).toBe(
      `chat-restore-marker:${fresh}:${encodeURIComponent(LEGACY_LEARNER)}:m1`,
    );
    const [record] = await server.rawRecords(marker!.id);
    expect((record!.payload as { runtimeSessionIds: string[] }).runtimeSessionIds).toEqual([
      `chat:${fresh}:${encodeURIComponent(LEGACY_LEARNER)}:chat-9`,
    ]);
  });
});

describe('narration rows from before the course column', () => {
  async function seedSharedNarration(holders: string[]): Promise<void> {
    // An imported deck numbers its actions by slide, so every import of it
    // carries the same derived key; the row names no course and no text.
    await seedDocumentsStore(
      holders.map((stageId) =>
        course(stageId, [
          {
            id: `${stageId}-scene`,
            order: 0,
            audioIds: [{ id: 'speech-scene-p1', audioId: 'tts_s1_speech-scene-p1', text: stageId }],
          },
        ]),
      ),
    );
    const legacy = new LegacyBrowserDatabase();
    await legacy.audioFiles.put({
      id: 'tts_s1_speech-scene-p1',
      blob: new Blob(['whose-voice'], { type: 'audio/mpeg' }),
      format: 'mp3',
      createdAt: NOW,
    });
    legacy.close();
  }

  it('is not adopted when two legacy courses name its key', async () => {
    await seedSharedNarration(['deck-a', 'deck-b']);
    await runLegacyBrowserImport(server.options(storage));
    for (const stageId of ['deck-a', 'deck-b']) {
      expect(speechIds((await server.rawDocument(stageId))!)).toEqual(['tts_s1_speech-scene-p1']);
    }
    expect(server.assets.size).toBe(0);
  });

  it('is adopted when only one legacy course names its key', async () => {
    await seedSharedNarration(['deck-a']);
    await runLegacyBrowserImport(server.options(storage));
    const [audioId] = speechIds((await server.rawDocument('deck-a'))!);
    expect(audioId).toMatch(/^ast_server/);
  });
});

describe('folders', () => {
  it('keeps the course imported when its folder is gone (404)', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation) =>
      operation === 'setMembership' ? httpError(404, 'FOLDER_NOT_FOUND') : undefined;

    const outcome = await runLegacyBrowserImport(server.options(storage));

    expect(outcome.status).toBe('complete');
    expect(outcome.ledger?.courses[TABLES_COURSE]).toMatchObject({ status: 'done' });
    expect(outcome.ledger?.courses[TABLES_COURSE]?.notes).toEqual([
      'left unfiled: 404 FOLDER_NOT_FOUND',
    ]);
  });

  it('treats membership in a folder the old database no longer has as unfiled', async () => {
    const legacy = new LegacyBrowserDatabase();
    await legacy.stages.put({ id: 'orphan', name: 'Orphan', createdAt: NOW, updatedAt: NOW });
    await legacy.scenes.put(slideScene('orphan', { id: 'o', order: 0 }) as unknown as SceneRecord);
    await legacy.stageFolders.put({ stageId: 'orphan', folderId: 'gone', updatedAt: NOW });
    legacy.close();

    const outcome = await runLegacyBrowserImport(server.options(storage));

    expect(outcome.status).toBe('complete');
    expect(outcome.ledger?.courses.orphan?.status).toBe('done');
  });
});

describe('legacy sources', () => {
  it('falls back to the original tables when the document store copy cannot be read', async () => {
    const legacy = new LegacyBrowserDatabase();
    await legacy.stages.put({ id: 'both', name: 'Tables copy', createdAt: NOW, updatedAt: NOW });
    await legacy.scenes.put(slideScene('both', { id: 'b', order: 0 }) as unknown as SceneRecord);
    legacy.close();
    const sources = {
      documents: {
        loadDocument: async () => {
          throw new Error('invalid scene');
        },
        listDocuments: async () => [],
      },
      runtime: null,
      assets: null,
      learnerKey: null,
      close: async () => undefined,
    } as unknown as LegacySources;

    const found = await readLegacyCourse(sources, 'both');

    expect(found).toMatchObject({ source: 'tables', document: { stage: { name: 'Tables copy' } } });
  });
});
