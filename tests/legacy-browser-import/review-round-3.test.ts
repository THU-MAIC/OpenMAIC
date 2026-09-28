/**
 * Review round 3: a transient failure never becomes a terminal ledger state,
 * two owners racing without Web Locks, the "not yours" cache, clocks, and the
 * client side of the claim confirmation.
 */
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runLegacyBrowserImport } from '@/lib/legacy-browser-import';
import { LEDGER_KEY, loadLedger } from '@/lib/legacy-browser-import/ledger';
import { LegacyBrowserDatabase } from '@/lib/legacy-browser-storage/schema';
import { isRetryableMediaFailure } from '@/lib/media/media-failure';
import { db } from '@/lib/device-storage/database';

import {
  FakeServer,
  MemoryStorage,
  NOW,
  OWNER_A,
  configureSeams,
  course,
  freshBrowser,
  seedDocumentsStore,
} from './harness';
import { DOCS_COURSE, TABLES_COURSE, seedLatestBrowser } from './fixtures';

/** Failures injected into the read-only legacy readers, one call each. */
const hooks = vi.hoisted(() => ({
  documentLoads: [] as ((stageId: string) => Error | undefined)[],
  tableReads: [] as ((stageId: string) => Error | undefined)[],
  /** Courses whose document-store read always fails (a broken record). */
  brokenDocuments: new Set<string>(),
}));

vi.mock('@/lib/legacy-browser-storage', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/legacy-browser-storage')>();
  const fail = (queue: ((id: string) => Error | undefined)[], id: string) => {
    const hook = queue[0];
    const error = hook?.(id);
    if (error) {
      queue.shift();
      throw error;
    }
  };
  return {
    ...original,
    openLegacyDocumentReader: async () => {
      const reader = await original.openLegacyDocumentReader();
      return (
        reader && {
          ...reader,
          loadDocument: async (id: string) => {
            if (hooks.brokenDocuments.has(id)) {
              throw new DOMException('Failed to read large IndexedDB value', 'DataError');
            }
            fail(hooks.documentLoads, id);
            return reader.loadDocument(id);
          },
        }
      );
    },
    readLegacyDocumentSnapshots: () => {
      const tables = original.readLegacyDocumentSnapshots();
      return {
        ...tables,
        read: async (id: string) => {
          fail(hooks.tableReads, id);
          return tables.read(id);
        },
      };
    },
  };
});

const aborted = () => new DOMException('The transaction was aborted', 'AbortError');
const LATER = NOW + 7 * 24 * 60 * 60 * 1000;

let storage: MemoryStorage;
let server: FakeServer;
let teardown: () => Promise<void>;

beforeEach(async () => {
  hooks.documentLoads.length = 0;
  hooks.tableReads.length = 0;
  hooks.brokenDocuments.clear();
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

const at = (time: number, extra: Record<string, unknown> = {}) =>
  server.options(storage, { now: () => time, ...extra });
const httpError = (status: number, code?: string) =>
  Object.assign(new Error(code ?? `HTTP ${status}`), { status, ...(code ? { code } : {}) });

describe('a storage failure while reading legacy data leaves work pending', () => {
  it('keeps a course pending when its document-store copy fails to read', async () => {
    await seedLatestBrowser(storage);
    // The quiz-scene index reads every course first; fail the course's own
    // read, the second of that id.
    let reads = 0;
    hooks.documentLoads.push((id) => (id === DOCS_COURSE && ++reads === 2 ? aborted() : undefined));
    const first = await runLegacyBrowserImport(server.options(storage));

    expect(first.ledger?.courses[DOCS_COURSE]).toMatchObject({ status: 'pending' });
    expect(first.status).toBe('pending');

    const second = await runLegacyBrowserImport(at(LATER));
    expect(second.status).toBe('complete');
    expect((await server.rawDocument(DOCS_COURSE))?.stage.name).toBe('Documents course');
  });

  it('holds up only the quiz decision when the scene index fails to read a course', async () => {
    await seedLatestBrowser(storage);
    // The first reader call of the run is the quiz-scene index of the tables course.
    hooks.tableReads.push((id) => (id === TABLES_COURSE ? aborted() : undefined));

    const first = await runLegacyBrowserImport(server.options(storage));
    // Every course reaches the server; only the quiz state waits.
    expect(first.ledger?.courses[DOCS_COURSE]?.status).toBe('done');
    expect(first.ledger?.courses[TABLES_COURSE]).toMatchObject({
      status: 'pending',
      steps: { document: 'done', chat: 'done' },
    });
    expect(first.ledger?.courses[TABLES_COURSE]?.steps.quiz).toBeUndefined();
    expect(first.ledger?.courses[TABLES_COURSE]?.readFailures?.count).toBe(1);

    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');
    const attempts = (await server.rawSessions(TABLES_COURSE)).filter(
      (session) => session.kind === 'quizAttempt',
    );
    expect(attempts).toHaveLength(1);
  });

  it('pauses instead of refusing narration when the speech index fails to read', async () => {
    await seedDocumentsStore([
      course('deck-a', [
        {
          id: 'deck-a-scene',
          order: 0,
          audioIds: [{ id: 'speech-scene-p1', audioId: 'tts_s1_speech-scene-p1', text: 'x' }],
        },
      ]),
    ]);
    const legacy = new LegacyBrowserDatabase();
    await legacy.audioFiles.put({
      id: 'tts_s1_speech-scene-p1',
      blob: new Blob(['voice'], { type: 'audio/mpeg' }),
      format: 'mp3',
      createdAt: NOW,
    });
    legacy.close();
    // readLegacyCourse finds the document-store copy and never reads the
    // tables; the next tables read is the speech index's.
    hooks.tableReads.push(() => aborted());

    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.ledger?.courses['deck-a']?.status).toBe('pending');

    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');
    const actions = (await server.rawDocument('deck-a'))!.scenes[0]!.actions!;
    expect((actions[0] as { audioId: string }).audioId).toMatch(/^ast_server/);
  });
});

describe('the document-store branch of the preliminary indexes', () => {
  it('holds up only the quiz decision when the quiz index cannot read a document-store course', async () => {
    await seedDocumentsStore([course('quizzed', [{ id: 'quizzed-scene', order: 0 }])]);
    storage.setItem('quizAnswers:quizzed-scene', JSON.stringify({ q1: 'A' }));
    // The first document read of the run is the quiz index's.
    hooks.documentLoads.push((id) => (id === 'quizzed' ? aborted() : undefined));

    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.ledger?.courses.quizzed).toMatchObject({ status: 'pending' });
    expect(first.ledger?.courses.quizzed?.steps.document).toBe('done');
    expect(first.ledger?.courses.quizzed?.steps.quiz).toBeUndefined();

    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');
    const attempts = (await server.rawSessions('quizzed')).filter((s) => s.kind === 'quizAttempt');
    expect(attempts).toHaveLength(1);
  });

  it('holds up only the narration decision when the speech index cannot read a document-store course', async () => {
    await seedDocumentsStore([
      course('deck-a', [
        {
          id: 'deck-a-scene',
          order: 0,
          audioIds: [{ id: 'speech-scene-p1', audioId: 'tts_s1_speech-scene-p1', text: 'x' }],
        },
      ]),
    ]);
    const legacy = new LegacyBrowserDatabase();
    await legacy.audioFiles.put({
      id: 'tts_s1_speech-scene-p1',
      blob: new Blob(['voice'], { type: 'audio/mpeg' }),
      format: 'mp3',
      createdAt: NOW,
    });
    legacy.close();
    // Read 1 is the course itself; read 2 is the speech index's.
    let reads = 0;
    hooks.documentLoads.push((id) => (id === 'deck-a' && ++reads === 2 ? aborted() : undefined));

    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.ledger?.courses['deck-a']?.status).toBe('pending');
    const pendingAudio = (await server.rawDocument('deck-a'))!.scenes[0]!.actions![0] as {
      audioId: string;
    };
    expect(pendingAudio.audioId).toBe('tts_s1_speech-scene-p1');

    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');
    const actions = (await server.rawDocument('deck-a'))!.scenes[0]!.actions!;
    expect((actions[0] as { audioId: string }).audioId).toMatch(/^ast_server/);
  });
});

describe('a course the old storage can never read', () => {
  const HOUR = 60 * 60 * 1000;

  it('lets every other course import, and settles after five runs over a day', async () => {
    await seedLatestBrowser(storage);
    hooks.brokenDocuments.add(DOCS_COURSE);

    const first = await runLegacyBrowserImport(server.options(storage));
    // Every other course is on the server after the first run.
    expect(first.ledger?.courses[TABLES_COURSE]?.steps.document).toBe('done');
    expect(server.stageOwners.get(TABLES_COURSE)).toBe(OWNER_A);
    expect(first.ledger?.courses[DOCS_COURSE]).toMatchObject({
      status: 'pending',
      readFailures: { count: 1, since: NOW },
    });

    let outcome = first;
    for (const hours of [6, 12, 18]) {
      outcome = await runLegacyBrowserImport(at(NOW + hours * HOUR));
      expect(outcome.ledger?.courses[DOCS_COURSE]?.status).toBe('pending');
    }
    // The fifth failing run, a day after the first: the course settles. It has
    // no older table copy, so it is skipped with the reason.
    outcome = await runLegacyBrowserImport(at(NOW + 24 * HOUR));
    expect(outcome.status).toBe('complete');
    expect(outcome.ledger?.courses[DOCS_COURSE]).toMatchObject({ status: 'skipped' });
    expect(outcome.ledger?.courses[DOCS_COURSE]?.reason).toMatch(/could not be read/);
    // The quiz state it was holding up came across.
    const attempts = (await server.rawSessions(TABLES_COURSE)).filter(
      (session) => session.kind === 'quizAttempt',
    );
    expect(attempts).toHaveLength(1);
  });

  it('falls back to the older table copy when there is one', async () => {
    await seedDocumentsStore([course('both', [{ id: 'both-new', order: 0 }], 'Newer copy')]);
    const legacy = new LegacyBrowserDatabase();
    await legacy.stages.put({ id: 'both', name: 'Older copy', createdAt: NOW, updatedAt: NOW });
    legacy.close();
    hooks.brokenDocuments.add('both');

    for (const hours of [0, 6, 12, 18]) {
      const run = await runLegacyBrowserImport(at(NOW + hours * HOUR));
      expect(run.ledger?.courses.both?.status).toBe('pending');
      expect(server.stageOwners.has('both')).toBe(false);
    }
    const settled = await runLegacyBrowserImport(at(NOW + 24 * HOUR));

    expect(settled.ledger?.courses.both?.status).toBe('done');
    expect((await server.rawDocument('both'))?.stage.name).toBe('Older copy');
    expect(settled.ledger?.courses.both?.notes?.[0]).toMatch(/older table copy/);
  });
});

describe('a failed read after a session-id collision', () => {
  it('retries the session instead of skipping it', async () => {
    await seedLatestBrowser(storage);
    let collided = false;
    let readFailed = false;
    server.failWith = (operation, subject) => {
      if (operation === 'createSession' && subject.startsWith('quiz-attempt:') && !collided) {
        collided = true;
        return httpError(409, 'SESSION_ALREADY_EXISTS');
      }
      if (
        operation === 'getSession' &&
        subject.startsWith('quiz-attempt:') &&
        collided &&
        !readFailed
      ) {
        readFailed = true;
        return httpError(503, 'UNAVAILABLE');
      }
      return undefined;
    };
    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.ledger?.courses[DOCS_COURSE]?.status).toBe('pending');

    server.failWith = () => undefined;
    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');
    const quiz = (await server.rawSessions(DOCS_COURSE)).find((s) => s.kind === 'quizAttempt')!;
    expect(await server.rawRecords(quiz.id)).toHaveLength(2);
  });
});

describe('a clock that ran ahead', () => {
  it('does not defer the import until a far-off date', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation, subject) =>
      operation === 'saveDocument' && subject === TABLES_COURSE ? httpError(502, 'BAD') : undefined;
    await runLegacyBrowserImport(server.options(storage));
    server.failWith = () => undefined;
    const ledger = loadLedger(storage)!;
    ledger.nextRunAt = NOW + 3 * 365 * 24 * 60 * 60 * 1000;
    storage.setItem(LEDGER_KEY, JSON.stringify(ledger));

    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');
  });
});

describe('refused uploads', () => {
  it('keeps Retry for generated media refused by a proxy without an error code', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation) => (operation === 'putAsset' ? httpError(413) : undefined);

    await runLegacyBrowserImport(server.options(storage));

    const record = await db.mediaFiles.get(`${DOCS_COURSE}:gen_img_1`);
    expect(record?.errorCode).toBe('UPLOAD_REFUSED');
    expect(isRetryableMediaFailure({ errorCode: record!.errorCode })).toBe(true);
  });

  it('leaves a video pending when its poster fails transiently, and stores both later', async () => {
    const legacy = new LegacyBrowserDatabase();
    await legacy.stages.put({ id: 'vid', name: 'Video', createdAt: NOW, updatedAt: NOW });
    await legacy.scenes.put({
      ...(course('vid', [{ id: 'vid-scene', order: 0, videoRef: 'gen_vid_1' }])
        .scenes[0] as object),
    } as never);
    const poster = new Blob(['poster-bytes-xyz'], { type: 'image/jpeg' });
    await legacy.mediaFiles.put({
      id: 'vid:gen_vid_1',
      stageId: 'vid',
      type: 'video',
      blob: new Blob(['video-bytes'], { type: 'video/mp4' }),
      poster,
      mimeType: 'video/mp4',
      size: 11,
      prompt: 'a clip',
      params: '{}',
      createdAt: NOW,
    });
    legacy.close();
    let failed = false;
    server.failWith = (operation, subject) => {
      if (operation === 'putAsset' && subject === String(poster.size) && !failed) {
        failed = true;
        return httpError(503, 'UNAVAILABLE');
      }
      return undefined;
    };

    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.ledger?.courses.vid?.status).toBe('pending');

    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');
    const video = (
      (await server.rawDocument('vid'))!.scenes[0]!.content as {
        canvas: { elements: { src: string; poster?: string }[] };
      }
    ).canvas.elements[0]!;
    expect(video.src).toMatch(/^ast_server/);
    expect(video.poster).toMatch(/^ast_server/);
  });
});
