/**
 * Once per browser: the first owner the server confirms claims the browser's
 * legacy data, and it moves to a different owner only when the server
 * confirms that owner absorbed the first one through a claim.
 */
import 'fake-indexeddb/auto';

import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runLegacyBrowserImport } from '@/lib/legacy-browser-import';
import { freshStageId } from '@/lib/legacy-browser-import/ids';
import { loadLedger } from '@/lib/legacy-browser-import/ledger';

import {
  FakeServer,
  MemoryStorage,
  NOW,
  OWNER_A,
  OWNER_B,
  configureSeams,
  course,
  freshBrowser,
} from './harness';
import { DOCS_COURSE, TABLES_COURSE, seedLatestBrowser } from './fixtures';

const OWNER_C = 'anon:cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LATER = NOW + 7 * 24 * 60 * 60 * 1000;

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

const at = (time: number, extra: Record<string, unknown> = {}) =>
  server.options(storage, { now: () => time, ...extra });
const httpError = (status: number, code: string) =>
  Object.assign(new Error(code), { status, code });
const heldBy = (owner: string) =>
  [...server.stageOwners]
    .filter(([, holder]) => holder === owner)
    .map(([id]) => id)
    .sort();

describe('an unrelated second owner never gets the data', () => {
  const deaths: [string, () => void][] = [
    [
      'nothing written',
      () => {
        server.failWith = (operation) =>
          ['saveDocument', 'createFolder'].includes(operation) ? httpError(502, 'BAD') : undefined;
      },
    ],
    [
      'partially written',
      () => {
        server.failWith = (operation, subject) =>
          operation === 'saveDocument' && subject === TABLES_COURSE
            ? httpError(502, 'BAD')
            : undefined;
      },
    ],
    [
      'a 401',
      () => {
        server.failWith = (operation) =>
          operation === 'saveDocument' ? httpError(401, 'INVALID_CREDENTIAL') : undefined;
      },
    ],
    [
      'a 5xx',
      () => {
        server.failWith = (operation) =>
          operation === 'createSession' ? httpError(503, 'UNAVAILABLE') : undefined;
      },
    ],
    [
      'the tab closing',
      () => {
        server.failWith = (operation) => {
          if (operation === 'appendRecord') throw new Error('tab closed');
          return undefined;
        };
      },
    ],
    [
      'a retirement nobody claimed into this owner',
      () => {
        server.failWith = (operation) =>
          operation === 'saveDocument' ? httpError(403, 'OWNER_RETIRED') : undefined;
      },
    ],
  ];

  it.each(deaths)('after the first run died on %s', async (_label, die) => {
    await seedLatestBrowser(storage);
    die();
    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.status).not.toBe('complete');
    expect(loadLedger(storage)?.ownerDigest).toBeDefined();

    server.failWith = () => undefined;
    server.owner = OWNER_B;
    const other = await runLegacyBrowserImport(at(LATER));

    expect(other.status).toBe('claimed-by-another-owner');
    expect(heldBy(OWNER_B)).toEqual([]);
    expect(server.folders.get(OWNER_B)).toBeUndefined();

    // The first owner finishes its own import on its next load.
    server.owner = OWNER_A;
    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');
    expect(heldBy(OWNER_A)).toEqual([DOCS_COURSE, TABLES_COURSE]);
  });

  it('does not count a course a host library lists for it as a claim', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation, subject) =>
      operation === 'saveDocument' && subject === TABLES_COURSE ? httpError(502, 'BAD') : undefined;
    await runLegacyBrowserImport(server.options(storage));

    server.failWith = () => undefined;
    server.owner = OWNER_B;
    // A host library provider lists a course B can read but does not own.
    const other = await runLegacyBrowserImport(
      at(LATER, {
        listOwnedStages: async () => [...(await server.listOwnedStages()), { id: DOCS_COURSE }],
      }),
    );

    expect(other.status).toBe('claimed-by-another-owner');
    expect(heldBy(OWNER_B)).toEqual([]);
  });

  it('does not count a claim into a third owner', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation, subject) =>
      operation === 'saveDocument' && subject === TABLES_COURSE ? httpError(502, 'BAD') : undefined;
    await runLegacyBrowserImport(server.options(storage));
    server.failWith = () => undefined;
    await server.claim(OWNER_A, OWNER_C);

    server.owner = OWNER_B;
    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('claimed-by-another-owner');
    expect(heldBy(OWNER_B)).toEqual([]);
  });

  it('asks the server again only after a while', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation, subject) =>
      operation === 'saveDocument' && subject === TABLES_COURSE ? httpError(502, 'BAD') : undefined;
    await runLegacyBrowserImport(server.options(storage));
    server.failWith = () => undefined;
    server.owner = OWNER_B;
    await runLegacyBrowserImport(at(LATER));

    server.calls.length = 0;
    expect((await runLegacyBrowserImport(at(LATER + 60_000))).status).toBe(
      'claimed-by-another-owner',
    );
    expect(server.calls).toEqual(['ownerId ']);
  });
});

describe('the first owner is bound only once the server confirmed it', () => {
  it('leaves the ledger unclaimed when the run dies before any authenticated request', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation) =>
      operation === 'listOwnedStages' ? httpError(502, 'BAD') : undefined;
    await runLegacyBrowserImport(server.options(storage));
    expect(loadLedger(storage)?.ownerDigest).toBeUndefined();

    server.failWith = () => undefined;
    server.owner = OWNER_B;
    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');
    expect(heldBy(OWNER_B)).toEqual([DOCS_COURSE, TABLES_COURSE]);
  });

  it('records the owner as SHA-256 of the salt and the owner id', async () => {
    await seedLatestBrowser(storage);
    await runLegacyBrowserImport(server.options(storage));
    const ledger = loadLedger(storage)!;
    expect(ledger.ownerDigest).toBe(
      createHash('sha256').update(`${ledger.salt}\u0000${OWNER_A}`).digest('hex'),
    );
  });
});

describe('the owner that claimed the first one gets the rest', () => {
  it('continues a half-imported course after a retirement mid-run, runtime included', async () => {
    await seedLatestBrowser(storage);
    let appends = 0;
    server.failWith = (operation) =>
      operation === 'appendRecord' && ++appends === 2 ? httpError(403, 'OWNER_RETIRED') : undefined;
    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.status).toBe('stopped');
    expect(first.ledger?.courses[DOCS_COURSE]?.status).toBe('pending');

    server.failWith = () => undefined;
    await server.claim(OWNER_A, OWNER_B);
    server.owner = OWNER_B;
    const second = await runLegacyBrowserImport(at(NOW + 1_000));

    expect(second.status).toBe('complete');
    const quiz = (await server.rawSessions(DOCS_COURSE, OWNER_B)).find(
      (session) => session.kind === 'quizAttempt',
    )!;
    expect(await server.rawRecords(quiz.id)).toHaveLength(2);
    expect(quiz.status).toBe('completed');
    expect(heldBy(OWNER_B)).toEqual([DOCS_COURSE, TABLES_COURSE]);
  });

  it('continues after a claim between loads, without a second fresh-id copy', async () => {
    await seedLatestBrowser(storage);
    await server.seedDocument(course(DOCS_COURSE, [{ id: 'theirs', order: 0 }]), OWNER_C);
    server.failWith = (operation, subject) =>
      operation === 'saveDocument' && subject === TABLES_COURSE ? httpError(502, 'BAD') : undefined;
    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.status).toBe('pending');
    const fresh = freshStageId(DOCS_COURSE, first.ledger!.salt);

    server.failWith = () => undefined;
    await server.claim(OWNER_A, OWNER_B);
    server.owner = OWNER_B;
    const second = await runLegacyBrowserImport(at(LATER));

    expect(second.status).toBe('complete');
    expect(heldBy(OWNER_B)).toEqual([fresh, TABLES_COURSE].sort());
  });

  it('does not bring back a course the user deleted before the claim', async () => {
    await seedLatestBrowser(storage);
    await server.seedDocument(course(DOCS_COURSE, [{ id: 'theirs', order: 0 }]), OWNER_C);
    server.failWith = (operation, subject) =>
      operation === 'saveDocument' && subject === TABLES_COURSE ? httpError(502, 'BAD') : undefined;
    const first = await runLegacyBrowserImport(server.options(storage));
    const fresh = freshStageId(DOCS_COURSE, first.ledger!.salt);
    server.deleted.add(fresh);

    server.failWith = () => undefined;
    await server.claim(OWNER_A, OWNER_B);
    server.owner = OWNER_B;
    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');

    expect(server.deleted.has(fresh)).toBe(true);
    expect(heldBy(OWNER_B).filter((id) => !server.deleted.has(id))).toEqual([TABLES_COURSE]);
  });
});

describe('run-level failures from any call stop the run', () => {
  it('pauses on a 401 on the "is the id taken" read, then imports everything', async () => {
    await seedLatestBrowser(storage);
    let failed = false;
    server.failWith = (operation, subject) => {
      if (operation === 'loadDocument' && subject === DOCS_COURSE && !failed) {
        failed = true;
        return httpError(401, 'INVALID_CREDENTIAL');
      }
      return undefined;
    };
    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.status).toBe('stopped');
    expect(loadLedger(storage)?.courses[DOCS_COURSE]).toMatchObject({ status: 'pending' });
    expect(loadLedger(storage)?.completedAt).toBeUndefined();

    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');
    expect(heldBy(OWNER_A)).toEqual([DOCS_COURSE, TABLES_COURSE]);
  });

  it.each([
    [401, 'INVALID_CREDENTIAL'],
    [403, 'OWNER_RETIRED'],
    [403, 'FORBIDDEN_LEARNER'],
    [503, 'OWNER_BUSY'],
  ])(
    'stops on %i %s from the library re-list and leaves the course pending',
    async (status, code) => {
      await seedLatestBrowser(storage);
      let listings = 0;
      const listing = server.listOwnedStages;
      const outcome = await runLegacyBrowserImport(
        server.options(storage, {
          listOwnedStages: async () => {
            listings += 1;
            if (listings === 2) throw httpError(status, code);
            return listing();
          },
        }),
      );

      expect(outcome.status).toBe('stopped');
      const ledger = loadLedger(storage)!;
      expect(ledger.courses[DOCS_COURSE]).toMatchObject({ status: 'pending' });
      expect(ledger.completedAt).toBeUndefined();
    },
  );
});
