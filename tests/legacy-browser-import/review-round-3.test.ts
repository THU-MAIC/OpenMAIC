/**
 * Review round 3: a transient failure never becomes a terminal ledger state,
 * two owners racing without Web Locks, the "not yours" cache, clocks, and the
 * client side of the claim confirmation.
 */
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OTHER_OWNER_RECHECK_MS,
  runLegacyBrowserImport,
  serverMergedFrom,
} from '@/lib/legacy-browser-import';
import { ownerDigest } from '@/lib/legacy-browser-import/digest';
import { LEDGER_KEY, loadLedger, saveLedger } from '@/lib/legacy-browser-import/ledger';
import { LegacyBrowserDatabase } from '@/lib/legacy-browser-storage/schema';
import { isRetryableMediaFailure } from '@/lib/media/media-failure';
import { db } from '@/lib/device-storage/database';

import {
  FakeServer,
  MemoryStorage,
  NOW,
  OWNER_A,
  OWNER_B,
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
const heldBy = (owner: string, on = server) =>
  [...on.stageOwners]
    .filter(([, holder]) => holder === owner)
    .map(([id]) => id)
    .sort();

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

  it('pauses instead of dropping quiz state when the scene index fails to read', async () => {
    await seedLatestBrowser(storage);
    // The first reader call of the run is the quiz-scene index.
    hooks.tableReads.push((id) => (id === TABLES_COURSE ? aborted() : undefined));

    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.status).toBe('pending');
    expect(Object.values(first.ledger?.courses ?? {}).every((e) => e.status === 'pending')).toBe(
      true,
    );

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

describe('two owners starting in two tabs without Web Locks', () => {
  it('lets only the owner whose binding was stored first write anything', async () => {
    await seedLatestBrowser(storage);
    const other = new FakeServer();
    other.owner = OWNER_B;
    // Both tabs finish their first library listing before either binds.
    let arrived = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = (list: () => Promise<{ id: string }[]>) => {
      let first = true;
      return async () => {
        const listed = await list();
        if (first) {
          first = false;
          arrived += 1;
          if (arrived === 2) release();
          await together;
        }
        return listed;
      };
    };

    const [a, b] = await Promise.all([
      runLegacyBrowserImport(
        server.options(storage, { listOwnedStages: barrier(server.listOwnedStages) }),
      ),
      runLegacyBrowserImport(
        other.options(storage, { listOwnedStages: barrier(other.listOwnedStages) }),
      ),
    ]);

    expect([a.status, b.status].sort()).toEqual(['complete', 'stopped']);
    const winner = a.status === 'complete' ? OWNER_A : OWNER_B;
    const salt = loadLedger(storage)!.salt;
    expect(loadLedger(storage)?.ownerDigest).toBe(ownerDigest(salt, winner));
    // The losing tab created nothing: no folder on its side, and each course
    // was saved once (by the winner).
    const loserFolders = winner === OWNER_A ? other : server;
    expect(loserFolders.calls.filter((call) => call.startsWith('createFolder'))).toEqual([]);
    expect(server.calls.filter((call) => call.startsWith('saveDocument'))).toHaveLength(2);
  });
});

describe('the "not yours" answer', () => {
  async function partlyImportedByA(): Promise<void> {
    await seedLatestBrowser(storage);
    server.failWith = (operation, subject) =>
      operation === 'saveDocument' && subject === TABLES_COURSE ? httpError(502, 'BAD') : undefined;
    await runLegacyBrowserImport(server.options(storage));
    server.failWith = () => undefined;
  }

  it('expires, so an owner that claims the first one later still gets the rest', async () => {
    await partlyImportedByA();
    server.owner = OWNER_B;
    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('claimed-by-another-owner');
    await server.claim(OWNER_A, OWNER_B);

    expect((await runLegacyBrowserImport(at(LATER + 60_000))).status).toBe(
      'claimed-by-another-owner',
    );
    const after = await runLegacyBrowserImport(at(LATER + OTHER_OWNER_RECHECK_MS + 1));
    expect(after.status).toBe('complete');
    expect(heldBy(OWNER_B)).toEqual([DOCS_COURSE, TABLES_COURSE]);
    // The handoff is stored: the ledger now names the claimant.
    const ledger = loadLedger(storage)!;
    expect(ledger.ownerDigest).toBe(ownerDigest(ledger.salt, OWNER_B));
  });

  it('written by a clock that ran ahead does not strand the claimant', async () => {
    await partlyImportedByA();
    const ledger = loadLedger(storage)!;
    const skewed = NOW + 3 * 365 * 24 * 60 * 60 * 1000;
    ledger.otherOwners = { [ownerDigest(ledger.salt, OWNER_B)]: skewed };
    ledger.nextRunAt = skewed;
    storage.setItem(LEDGER_KEY, JSON.stringify(ledger));
    await server.claim(OWNER_A, OWNER_B);

    server.owner = OWNER_B;
    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');
  });

  it('drops expired entries when the ledger is saved', () => {
    const fresh = new MemoryStorage();
    const ledger = { ...loadLedgerOrNew(fresh), otherOwners: { a: NOW - 1, b: NOW + 5 } };
    saveLedger(fresh, ledger, NOW);
    expect(loadLedger(fresh)?.otherOwners).toEqual({ b: NOW + 5 });
  });
});

function loadLedgerOrNew(backing: Storage) {
  backing.setItem(
    LEDGER_KEY,
    JSON.stringify({ version: 2, salt: 'ab'.repeat(16), failedRuns: 0, courses: {}, folders: {} }),
  );
  return loadLedger(backing)!;
}

describe('the client side of the claim confirmation', () => {
  it('asks the owner-scoped route with the salt and digest and reads only merged: true', async () => {
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ merged: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    expect(await serverMergedFrom('ab'.repeat(16), 'c'.repeat(64))).toBe(true);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      `/api/identity/merged-from?salt=${'ab'.repeat(16)}&digest=${'c'.repeat(64)}`,
    );
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ cache: 'no-store' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ merged: 'yes' })));
    expect(await serverMergedFrom('ab'.repeat(16), 'c'.repeat(64))).toBe(false);
  });

  it('carries the status and code of a refusal so the run can pause or stop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'INVALID_CREDENTIAL' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(serverMergedFrom('ab'.repeat(16), 'c'.repeat(64))).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIAL',
    });
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
