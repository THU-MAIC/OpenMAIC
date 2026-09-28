/**
 * The one-way legacy browser importer, end to end over real (fake-indexeddb)
 * legacy databases and an owner-aware in-memory server behind the app's own
 * persistence seams.
 */
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearLocalCache,
  clearLocalStorageKeepingImportState,
} from '@/lib/device-storage/clear-local-cache';
import { db } from '@/lib/device-storage/database';
import { runLegacyBrowserImport } from '@/lib/legacy-browser-import';
import { freshStageId } from '@/lib/legacy-browser-import/ids';
import { LEDGER_KEY, loadLedger } from '@/lib/legacy-browser-import/ledger';
import { loadCursorValue } from '@/lib/playback/cursor';
import { loadCurrentSceneValue } from '@/lib/document-store/current-scene';
import { BrowserKVStore } from '@openmaic/storage';
import { loadChatSessions } from '@/lib/utils/chat-storage';

import {
  FakeServer,
  LEGACY_LEARNER,
  MemoryStorage,
  NOW,
  OWNER_A,
  OWNER_B,
  configureSeams,
  course,
  freshBrowser,
  dumpLegacyDatabases,
  legacyLocalStorage,
} from './harness';
import {
  DOCS_COURSE,
  GEN_IMAGE,
  NARRATION,
  NARRATION_KEY,
  POOL_IMAGE,
  TABLES_COURSE,
  TABLE_NARRATION,
  TABLE_NARRATION_KEY,
  seedLatestBrowser,
} from './fixtures';

/** Read chat back without the cross-tab lock the regular path requires (none in Node). */
const NO_LEGACY_CHAT = { legacyStore: { load: async () => [], clear: async () => undefined } };

let storage: MemoryStorage;
let server: FakeServer;
let teardown: () => Promise<void>;

async function bytes(blob: Blob | undefined): Promise<string> {
  return blob ? Buffer.from(await blob.arrayBuffer()).toString() : '<none>';
}

function speechAudioIds(document: { scenes: { actions?: unknown[] }[] }): string[] {
  return document.scenes.flatMap((scene) =>
    (scene.actions ?? []).map((action) => (action as { audioId?: string }).audioId ?? ''),
  );
}

function imageSrcs(document: { scenes: unknown[] }): string[] {
  return document.scenes.flatMap((scene) => {
    const content = (scene as { content: { canvas?: { elements: { src?: string }[] } } }).content;
    return (content.canvas?.elements ?? []).map((element) => element.src ?? '');
  });
}

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

describe('a browser-only browser, imported into an empty server', () => {
  it('moves every course with its media, runtime, chat, playback, roster, folders and quiz state', async () => {
    const { poolImageId } = await seedLatestBrowser(storage);

    const outcome = await runLegacyBrowserImport(server.options(storage));

    expect(outcome.status).toBe('complete');
    expect(outcome.ledger?.courses[DOCS_COURSE]).toMatchObject({
      status: 'done',
      origin: 'created',
      target: DOCS_COURSE,
    });
    expect(outcome.ledger?.courses[TABLES_COURSE]).toMatchObject({ status: 'done' });

    // The documents course: every local reference now names a server asset
    // holding the same bytes, except the refused element, which keeps its
    // placeholder (the app shows it as refused, and does not regenerate it).
    const docs = (await server.rawDocument(DOCS_COURSE))!;
    const [poolRef, genRef, refusedRef] = imageSrcs(docs);
    expect(poolRef).toMatch(/^ast_server/);
    expect(poolRef).not.toBe(poolImageId);
    expect(await bytes(server.assets.get(poolRef!)?.blob)).toBe(await bytes(POOL_IMAGE));
    expect(genRef).toMatch(/^ast_server/);
    expect(await bytes(server.assets.get(genRef!)?.blob)).toBe(await bytes(GEN_IMAGE));
    expect(refusedRef).toBe('gen_img_2');
    const [narrationRef] = speechAudioIds(docs);
    expect(narrationRef).toMatch(/^ast_server/);
    expect(await bytes(server.assets.get(narrationRef!)?.blob)).toBe(await bytes(NARRATION));

    // The tables course: canonicalized, roster lifted, narration converted.
    const tables = (await server.rawDocument(TABLES_COURSE))!;
    expect(tables.stage.name).toBe('Tables course');
    expect(tables.scenes.map((scene) => scene.id)).toEqual(['tables-scene-1', 'tables-quiz']);
    expect(tables.outline).toMatchObject({ generationComplete: true });
    expect(tables.stage.generatedAgentConfigs?.map((agent) => agent.id)).toEqual([
      'gen-teacher',
      'gen-student',
    ]);
    expect(tables.stage.generatedAgentConfigs?.[0]?.voiceDesign).toEqual({
      identity: 'warm',
      delivery: 'slow',
    });
    const [tableNarrationRef] = speechAudioIds(tables);
    expect(tableNarrationRef).toMatch(/^ast_server/);
    expect(await bytes(server.assets.get(tableNarrationRef!)?.blob)).toBe(
      await bytes(TABLE_NARRATION),
    );

    // Runtime from the browser runtime store, now the server learner's.
    const sessions = await server.rawSessions(DOCS_COURSE);
    expect(sessions.map((session) => [session.kind, session.status]).sort()).toEqual([
      ['quizAttempt', 'completed'],
      ['whiteboard', 'active'],
    ]);
    const quiz = sessions.find((session) => session.kind === 'quizAttempt')!;
    expect(quiz.learnerKey).toBe(OWNER_A);
    expect((await server.rawRecords(quiz.id)).map((record) => record.payload)).toEqual([
      { payloadVersion: 1, phase: 'draft', answers: { q1: 'A' } },
      { payloadVersion: 1, phase: 'submitted', answers: { q1: 'B' } },
    ]);

    // Chat from the old table, readable through the regular chat path.
    const chats = await loadChatSessions(TABLES_COURSE, {
      store: server.runtime,
      learnerKey: OWNER_A,
      observe: false,
      ...NO_LEGACY_CHAT,
    });
    expect(chats.map((chat) => [chat.id, chat.messages.length])).toEqual([['chat-1', 2]]);

    // Pre-runtime quiz keys of the quiz scene, now a runtime quiz attempt.
    const tablesSessions = await server.rawSessions(TABLES_COURSE);
    const quizAttempts = tablesSessions.filter((session) => session.kind === 'quizAttempt');
    expect(quizAttempts).toHaveLength(1);
    const quizPayloads = (await server.rawRecords(quizAttempts[0]!.id)).map(
      (record) => record.payload as { phase: string },
    );
    expect(quizPayloads.at(-1)).toMatchObject({ phase: 'reviewed', answers: { q1: 'C' } });

    // Device positions: the playback row's scene index, the stage's scene.
    const kv = new BrowserKVStore({ storage });
    expect(await loadCursorValue(TABLES_COURSE, kv)).toMatchObject({
      sceneId: 'tables-quiz',
      actionIndex: 0,
    });
    expect(await loadCurrentSceneValue(TABLES_COURSE, kv)).toMatchObject({
      sceneId: 'tables-quiz',
    });

    // Folders by name, membership mapped, the empty folder too.
    expect(server.folders.get(OWNER_A)?.map((folder) => folder.name)).toEqual(['Physics', 'Empty']);
    expect(server.membership.get(TABLES_COURSE)).toBe(
      server.folders.get(OWNER_A)?.find((folder) => folder.name === 'Physics')?.id,
    );

    // Device-only rows: the refusal record (so the element is not generated
    // again) and the auto-voice clip.
    const failure = await db.mediaFiles.get(`${DOCS_COURSE}:gen_img_2`);
    expect(failure).toMatchObject({ errorCode: 'CONTENT_SENSITIVE', stageId: DOCS_COURSE });
    expect(await db.autoVoiceCache.get('auto-voice-1')).toMatchObject({ mimeType: 'audio/wav' });
  });

  it('writes nothing to any legacy database or legacy localStorage key', async () => {
    await seedLatestBrowser(storage);
    const before = await dumpLegacyDatabases();
    const keysBefore = legacyLocalStorage(storage);

    expect((await runLegacyBrowserImport(server.options(storage))).status).toBe('complete');

    expect(await dumpLegacyDatabases()).toEqual(before);
    expect(legacyLocalStorage(storage)).toEqual(keysBefore);
    expect(keysBefore.length).toBeGreaterThan(1);
  });

  it('announces the library change so an open library lists the courses', async () => {
    await seedLatestBrowser(storage);
    const listener = vi.fn();
    (window as unknown as EventTarget).addEventListener('openmaic:library-changed', listener);

    await runLegacyBrowserImport(server.options(storage));

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('idempotency and resumption', () => {
  it('imports nothing twice when it runs again', async () => {
    await seedLatestBrowser(storage);
    await runLegacyBrowserImport(server.options(storage));
    const assets = server.assets.size;
    const sessions = (await server.rawSessions(DOCS_COURSE)).length;

    // The ledger says complete: a second run does not even touch the server.
    server.calls.length = 0;
    expect((await runLegacyBrowserImport(server.options(storage))).status).toBe('already-complete');
    expect(server.calls).toEqual([]);

    // And with the ledger gone, the server-side checks still keep it from
    // duplicating anything.
    storage.removeItem(LEDGER_KEY);
    expect((await runLegacyBrowserImport(server.options(storage))).status).toBe('complete');
    expect(server.assets.size).toBe(assets);
    expect(await server.rawSessions(DOCS_COURSE)).toHaveLength(sessions);
    expect(server.folders.get(OWNER_A)).toHaveLength(2);
    const chats = await loadChatSessions(TABLES_COURSE, {
      store: server.runtime,
      learnerKey: OWNER_A,
      observe: false,
      ...NO_LEGACY_CHAT,
    });
    expect(chats).toHaveLength(1);
  });

  it('stays complete after Clear Local Cache, and the legacy data stays too', async () => {
    await seedLatestBrowser(storage);
    await runLegacyBrowserImport(server.options(storage));
    const legacyBefore = await dumpLegacyDatabases();
    // A course the user deleted on the server after it was imported.
    server.deleted.add(DOCS_COURSE);

    await clearLocalCache();
    clearLocalStorageKeepingImportState(storage);

    expect(loadLedger(storage)?.completedAt).toBeDefined();
    expect((await runLegacyBrowserImport(server.options(storage))).status).toBe('already-complete');
    expect(server.deleted.has(DOCS_COURSE)).toBe(true);
    expect(await dumpLegacyDatabases()).toEqual(legacyBefore);
  });

  it('resumes after a crash mid-import without duplicating anything', async () => {
    await seedLatestBrowser(storage);
    // The run dies (the tab is closed) on the second record of the quiz
    // session, after the documents and the first record landed.
    let appends = 0;
    server.failWith = (operation) => {
      if (operation === 'appendRecord' && ++appends === 2) {
        throw new Error('tab closed');
      }
      return undefined;
    };
    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.status).toBe('pending');
    expect(first.ledger?.courses[DOCS_COURSE]?.status).toBe('pending');
    expect(first.ledger?.nextRunAt).toBe(NOW + 30_000);

    server.failWith = () => undefined;
    const second = await runLegacyBrowserImport(
      server.options(storage, { now: () => first.ledger!.nextRunAt! + 1 }),
    );
    expect(second.status).toBe('complete');
    const quiz = (await server.rawSessions(DOCS_COURSE)).find(
      (session) => session.kind === 'quizAttempt',
    )!;
    expect(await server.rawRecords(quiz.id)).toHaveLength(2);
    expect(quiz.status).toBe('completed');
    expect([...server.stageOwners.keys()].sort()).toEqual([DOCS_COURSE, TABLES_COURSE]);
  });

  it('defers a retry until the backoff has passed', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation) =>
      operation === 'listOwnedStages' ? new Error('network down') : undefined;
    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.status).toBe('pending');
    server.failWith = () => undefined;
    expect((await runLegacyBrowserImport(server.options(storage))).status).toBe('deferred');
  });
});

describe('conflicts with what the server already has', () => {
  it('keeps a course this owner already has and only fills in its missing media', async () => {
    await seedLatestBrowser(storage);
    // An earlier opt-in server build synced the documents course, renamed on
    // the server since, with the generated image still a placeholder.
    const serverCopy = course(DOCS_COURSE, [
      { id: 'docs-scene-2', order: 0, imageRef: 'gen_img_1' },
    ]);
    serverCopy.stage.name = 'Renamed on the server';
    await server.seedDocument(serverCopy);

    const outcome = await runLegacyBrowserImport(server.options(storage));

    expect(outcome.ledger?.courses[DOCS_COURSE]).toMatchObject({
      status: 'done',
      origin: 'existing',
    });
    const after = (await server.rawDocument(DOCS_COURSE))!;
    expect(after.stage.name).toBe('Renamed on the server');
    expect(after.scenes.map((scene) => scene.id)).toEqual(['docs-scene-2']);
    const [imageRef] = imageSrcs(after);
    expect(await bytes(server.assets.get(imageRef!)?.blob)).toBe(await bytes(GEN_IMAGE));
    // Server runtime is authoritative for such a course: nothing copied.
    expect(await server.rawSessions(DOCS_COURSE)).toEqual([]);
  });

  it('imports a course whose id another owner holds under a fresh id, references included', async () => {
    await seedLatestBrowser(storage);
    await server.seedDocument(course(DOCS_COURSE, [{ id: 'theirs', order: 0 }]), OWNER_B);
    await server.seedDocument(course(TABLES_COURSE, [{ id: 'theirs-2', order: 0 }]), OWNER_B);

    const outcome = await runLegacyBrowserImport(server.options(storage));

    const salt = outcome.ledger!.salt;
    const docsId = freshStageId(DOCS_COURSE, salt);
    const tablesId = freshStageId(TABLES_COURSE, salt);
    expect(outcome.ledger?.courses[DOCS_COURSE]).toMatchObject({ status: 'done', target: docsId });
    // The other owner's courses are untouched.
    expect((await server.rawDocument(DOCS_COURSE))!.scenes.map((scene) => scene.id)).toEqual([
      'theirs',
    ]);
    const imported = (await server.rawDocument(docsId))!;
    expect(imported.scenes.every((scene) => scene.stageId === docsId)).toBe(true);
    expect(server.stageOwners.get(docsId)).toBe(OWNER_A);

    // Runtime session ids carry the new course id; the chat layer finds them.
    const sessions = await server.rawSessions(docsId);
    expect(sessions.map((session) => session.id).sort()).toEqual([
      `quiz-attempt:${docsId}:docs-scene-3:${encodeURIComponent(LEGACY_LEARNER)}`,
      `whiteboard:${docsId}:${encodeURIComponent(LEGACY_LEARNER)}`,
    ]);
    const chats = await loadChatSessions(tablesId, {
      store: server.runtime,
      learnerKey: OWNER_A,
      observe: false,
      ...NO_LEGACY_CHAT,
    });
    expect(chats.map((chat) => chat.id)).toEqual(['chat-1']);

    // Positions, membership and device rows follow the new id.
    const kv = new BrowserKVStore({ storage });
    expect(await loadCursorValue(tablesId, kv)).toMatchObject({ sceneId: 'tables-quiz' });
    expect(server.membership.get(tablesId)).toBeDefined();
    expect(await db.mediaFiles.get(`${docsId}:gen_img_2`)).toMatchObject({ stageId: docsId });
  });

  it('respects a course this owner deleted on the server', async () => {
    await seedLatestBrowser(storage);
    await server.seedDocument(course(DOCS_COURSE, [{ id: 'mine', order: 0 }]));
    server.deleted.add(DOCS_COURSE);

    const outcome = await runLegacyBrowserImport(server.options(storage));

    expect(outcome.ledger?.courses[DOCS_COURSE]).toMatchObject({
      status: 'skipped',
      reason: 'deleted on the server',
    });
    expect(server.deleted.has(DOCS_COURSE)).toBe(true);
    expect(outcome.status).toBe('complete');
  });

  it('imports once per browser: a different owner later gets nothing', async () => {
    await seedLatestBrowser(storage);
    await runLegacyBrowserImport(server.options(storage));
    expect(loadLedger(storage)?.completedAt).toBeDefined();

    server.owner = OWNER_B;
    const outcome = await runLegacyBrowserImport(server.options(storage));

    expect(outcome.status).toBe('already-complete');
    expect([...server.stageOwners.values()]).not.toContain(OWNER_B);
    expect(server.folders.get(OWNER_B)).toBeUndefined();
  });

  it('gives a different owner nothing while the first owner is still importing', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation, subject) =>
      operation === 'saveDocument' && subject === TABLES_COURSE
        ? Object.assign(new Error('bad gateway'), { status: 502 })
        : undefined;
    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.status).toBe('pending');

    server.failWith = () => undefined;
    server.owner = OWNER_B;
    const other = await runLegacyBrowserImport(
      server.options(storage, { now: () => first.ledger!.nextRunAt! }),
    );

    expect(other.status).toBe('claimed-by-another-owner');
    expect([...server.stageOwners.values()]).not.toContain(OWNER_B);
    // The first owner finishes its own import on its next load.
    server.owner = OWNER_A;
    const resumed = await runLegacyBrowserImport(
      server.options(storage, { now: () => first.ledger!.nextRunAt! }),
    );
    expect(resumed.status).toBe('complete');
    expect(server.stageOwners.get(TABLES_COURSE)).toBe(OWNER_A);
  });
});

describe('failures', () => {
  it('leaves transient failures pending and finishes on a later load', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation, subject) =>
      operation === 'saveDocument' && subject === TABLES_COURSE
        ? Object.assign(new Error('bad gateway'), { status: 502, code: 'HTTP_ERROR' })
        : undefined;

    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.status).toBe('pending');
    expect(first.ledger?.courses[DOCS_COURSE]?.status).toBe('done');
    expect(first.ledger?.courses[TABLES_COURSE]).toMatchObject({
      status: 'pending',
      reason: '502 HTTP_ERROR',
    });

    server.failWith = () => undefined;
    const second = await runLegacyBrowserImport(
      server.options(storage, { now: () => first.ledger!.nextRunAt! }),
    );
    expect(second.status).toBe('complete');
    expect(server.stageOwners.get(TABLES_COURSE)).toBe(OWNER_A);
  });

  it('pauses on OWNER_BUSY and retries after Retry-After', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation) =>
      operation === 'saveDocument'
        ? Object.assign(new Error('busy'), { status: 503, code: 'OWNER_BUSY', retryAfterMs: 5_000 })
        : undefined;

    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.status).toBe('stopped');
    expect(loadLedger(storage)?.nextRunAt).toBe(NOW + 5_000);
    expect((await runLegacyBrowserImport(server.options(storage))).status).toBe('deferred');
    server.failWith = () => undefined;
    const later = await runLegacyBrowserImport(server.options(storage, { now: () => NOW + 5_000 }));
    expect(later.status).toBe('complete');
  });

  it('pauses on a 401 and imports everything once the credential is back', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation) =>
      operation === 'saveDocument'
        ? Object.assign(new Error('expired'), { status: 401, code: 'INVALID_CREDENTIAL' })
        : undefined;

    const first = await runLegacyBrowserImport(server.options(storage));

    expect(first.status).toBe('stopped');
    const ledger = loadLedger(storage)!;
    expect(ledger.completedAt).toBeUndefined();
    expect(ledger.nextRunAt).toBe(NOW + 30_000);
    expect(Object.values(ledger.courses).every((entry) => entry.status === 'pending')).toBe(true);

    server.failWith = () => undefined;
    const second = await runLegacyBrowserImport(
      server.options(storage, { now: () => ledger.nextRunAt! }),
    );
    expect(second.status).toBe('complete');
    expect([...server.stageOwners.keys()].sort()).toEqual([DOCS_COURSE, TABLES_COURSE]);
  });

  it('records a validation refusal on that course and continues with the rest', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation, subject) =>
      operation === 'saveDocument' && subject === DOCS_COURSE
        ? Object.assign(new Error('invalid'), { status: 400, code: 'VALIDATION_FAILED' })
        : undefined;

    const outcome = await runLegacyBrowserImport(server.options(storage));

    expect(outcome.status).toBe('complete');
    expect(outcome.ledger?.courses[DOCS_COURSE]).toMatchObject({
      status: 'failed',
      reason: '400 VALIDATION_FAILED',
    });
    expect(outcome.ledger?.courses[TABLES_COURSE]?.status).toBe('done');
  });

  it('skips a legacy record that fails validation and imports the others', async () => {
    await seedLatestBrowser(storage);
    const { LegacyBrowserDatabase } = await import('@/lib/legacy-browser-storage/schema');
    const legacy = new LegacyBrowserDatabase();
    await legacy.stages.put({ id: 'broken', name: 'Broken', createdAt: 1, updatedAt: 1 });
    await legacy.scenes.put({
      id: 'broken-scene',
      stageId: 'broken',
      type: 'slide',
      title: 'Broken',
      order: 0,
      content: { type: 'slide' } as never,
      createdAt: 1,
      updatedAt: 1,
    });
    legacy.close();

    const outcome = await runLegacyBrowserImport(server.options(storage));

    expect(outcome.status).toBe('complete');
    expect(outcome.ledger?.courses.broken?.status).toBe('skipped');
    expect(outcome.ledger?.courses.broken?.reason).toMatch(/invalid legacy record/);
    expect(server.stageOwners.has('broken')).toBe(false);
    expect(outcome.ledger?.courses[DOCS_COURSE]?.status).toBe('done');
  });

  it('imports the document when the asset store is full, and loses no media', async () => {
    await seedLatestBrowser(storage);
    server.quotaBytes = 0;

    const outcome = await runLegacyBrowserImport(server.options(storage));

    // The courses are on the server, still naming their local references.
    const docs = (await server.rawDocument(DOCS_COURSE))!;
    expect(imageSrcs(docs)[1]).toBe('gen_img_1');
    expect(speechAudioIds(docs)[0]).toBe(NARRATION_KEY);
    // A placeholder's and a narration clip's bytes are where the app's own
    // retry finds them (no provider call needed)...
    expect(await bytes((await db.mediaFiles.get(`${DOCS_COURSE}:gen_img_1`))?.blob)).toBe(
      await bytes(GEN_IMAGE),
    );
    expect(await db.audioFiles.get(NARRATION_KEY)).toMatchObject({ stageId: DOCS_COURSE });
    expect(await db.audioFiles.get(TABLE_NARRATION_KEY)).toMatchObject({ stageId: TABLES_COURSE });
    // ...and the pool image, which has no such path, stays pending for the importer.
    const media = outcome.ledger?.courses[DOCS_COURSE]?.media ?? {};
    expect(Object.values(media).filter((entry) => entry.status === 'pending')).toHaveLength(1);
    expect(outcome.status).toBe('pending');

    // Room appears: the next run converts the pending image.
    server.quotaBytes = Number.POSITIVE_INFINITY;
    const second = await runLegacyBrowserImport(
      server.options(storage, { now: () => outcome.ledger!.nextRunAt! }),
    );
    expect(second.status).toBe('complete');
    expect(imageSrcs((await server.rawDocument(DOCS_COURSE))!)[0]).toMatch(/^ast_server/);
  });

  it('does nothing when server persistence is unavailable', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation) =>
      operation === 'ownerId' ? new Error('Runtime learner key request failed: 500') : undefined;

    const outcome = await runLegacyBrowserImport(server.options(storage));

    expect(outcome.status).toBe('unavailable');
    expect(server.stageOwners.size).toBe(0);
    expect(storage.getItem(LEDGER_KEY)).toBeNull();
  });

  it('does nothing in a browser that never stored anything locally', async () => {
    const outcome = await runLegacyBrowserImport(server.options(storage));
    expect(outcome.status).toBe('no-legacy-data');
    expect(server.calls).toEqual([]);
    expect((await indexedDB.databases()).map((info) => info.name)).not.toContain('MAIC-Database');
  });
});

describe('two tabs', () => {
  it('lets one tab import while the other stands aside', async () => {
    await seedLatestBrowser(storage);
    const held = new Set<string>();
    const locks = {
      async request(
        name: string,
        options: LockOptions,
        callback: (lock: Lock | null) => Promise<unknown>,
      ) {
        if (held.has(name)) return callback(null);
        held.add(name);
        try {
          return await callback({ name, mode: options.mode ?? 'exclusive' } as Lock);
        } finally {
          held.delete(name);
        }
      },
    } as unknown as LockManager;

    const [first, second] = await Promise.all([
      runLegacyBrowserImport(server.options(storage, { locks })),
      runLegacyBrowserImport(server.options(storage, { locks })),
    ]);

    expect([first.status, second.status].sort()).toEqual(['busy-elsewhere', 'complete']);
    expect([...server.stageOwners.keys()].sort()).toEqual([DOCS_COURSE, TABLES_COURSE]);
    expect(server.folders.get(OWNER_A)).toHaveLength(2);
  });
});
