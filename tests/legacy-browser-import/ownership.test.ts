/**
 * Once per browser, decided by the server: the browser's random id is bound to
 * the first owner that asks, every importer request of any other owner is
 * refused (409 LEGACY_IMPORT_NOT_BOUND), and a claim carries the binding to
 * the account. The fake server models the real one (atomic bind, fence on
 * every call, claim re-keying the binding); the route suite
 * (`tests/server/identity/legacy-import-binding-route.test.ts`) and the `.pg`
 * suite run the real routes.
 */
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OTHER_OWNER_RECHECK_MS, runLegacyBrowserImport } from '@/lib/legacy-browser-import';
import { freshStageId } from '@/lib/legacy-browser-import/ids';
import { loadLedger } from '@/lib/legacy-browser-import/ledger';
import type { ImportClients } from '@/lib/legacy-browser-import/server';

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
const writesBy = (owner: string) => heldBy(owner).length + (server.folders.get(owner)?.length ?? 0);

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

    server.failWith = () => undefined;
    server.owner = OWNER_B;
    const other = await runLegacyBrowserImport(at(LATER));

    expect(other.status).toBe('claimed-by-another-owner');
    expect(writesBy(OWNER_B)).toBe(0);

    // The first owner finishes its own import on a load after the recheck
    // delay the refused owner's load recorded (the ledger names no owner).
    server.owner = OWNER_A;
    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('deferred');
    expect((await runLegacyBrowserImport(at(LATER + OTHER_OWNER_RECHECK_MS))).status).toBe(
      'complete',
    );
    expect(heldBy(OWNER_A)).toEqual([DOCS_COURSE, TABLES_COURSE]);
  });

  it('does not count a course a host library lists for it', async () => {
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
    expect(writesBy(OWNER_B)).toBe(0);
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
    expect(writesBy(OWNER_B)).toBe(0);
  });
});

describe('two owners racing for the binding', () => {
  it('lets exactly one win; the other writes nothing', async () => {
    await seedLatestBrowser(storage);
    // Two tabs of two owners, no Web Locks, both past their first request.
    const [a, b] = await Promise.all([
      runLegacyBrowserImport(
        server.options(storage, { connect: (id: string) => server.clients(id, OWNER_A) }),
      ),
      runLegacyBrowserImport(
        server.options(storage, { connect: (id: string) => server.clients(id, OWNER_B) }),
      ),
    ]);

    expect([a.status, b.status].sort()).toEqual(['claimed-by-another-owner', 'complete']);
    const winner = a.status === 'complete' ? OWNER_A : OWNER_B;
    const loser = winner === OWNER_A ? OWNER_B : OWNER_A;
    expect([...server.bindings.values()]).toEqual([winner]);
    expect(writesBy(loser)).toBe(0);
  });

  it('fences the loser even when its client believes it is bound', async () => {
    await seedLatestBrowser(storage);
    server.owner = OWNER_A;
    expect((await runLegacyBrowserImport(server.options(storage))).status).toBe('complete');
    const ledger = loadLedger(storage)!;
    // Replay the import for B from a pristine ledger, with a client whose
    // bind answers "yes" regardless: every write must still be refused.
    storage.setItem(
      'maic:legacy-import:v3',
      JSON.stringify({ ...ledger, courses: {}, folders: {}, completedAt: undefined }),
    );
    server.owner = OWNER_B;
    const lying = (id: string): ImportClients => ({
      ...server.clients(id),
      bind: async () => true,
    });

    const outcome = await runLegacyBrowserImport(at(NOW, { connect: lying }));

    expect(outcome.status).toBe('stopped');
    expect(writesBy(OWNER_B)).toBe(0);
  });
});

describe('the page owner and the cookie owner differ', () => {
  it('lands nothing under the cookie owner when the browser is bound to another', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation, subject) =>
      operation === 'saveDocument' && subject === TABLES_COURSE ? httpError(502, 'BAD') : undefined;
    await runLegacyBrowserImport(server.options(storage));
    server.failWith = () => undefined;
    // The page was loaded as A; B signed in in another tab without a claim.
    // The importer never uses the page's owner: the server resolves B.
    server.owner = OWNER_B;

    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('claimed-by-another-owner');
    expect(writesBy(OWNER_B)).toBe(0);
  });

  it('stops at the next write when the cookie switches mid-run', async () => {
    await seedLatestBrowser(storage);
    // The switch lands between the run's binding and its first course write
    // (the gap between any check the client makes and the write).
    server.failWith = (operation) => {
      if (operation === 'fenced:saveDocument') server.owner = OWNER_B;
      return undefined;
    };

    const outcome = await runLegacyBrowserImport(server.options(storage));

    expect(outcome.status).toBe('stopped');
    expect(writesBy(OWNER_B)).toBe(0);
    expect(loadLedger(storage)?.completedAt).toBeUndefined();
  });

  it('never asks the page for its learner key', async () => {
    await seedLatestBrowser(storage);
    const learnerKeys: string[] = [];
    const tracking = (id: string): ImportClients => {
      const clients = server.clients(id);
      return {
        ...clients,
        learnerKey: async () => {
          const key = await clients.learnerKey();
          learnerKeys.push(key);
          return key;
        },
      };
    };
    await runLegacyBrowserImport(server.options(storage, { connect: tracking }));
    expect(learnerKeys).toEqual([OWNER_A]);
    const quiz = (await server.rawSessions(DOCS_COURSE)).find((s) => s.kind === 'quizAttempt');
    expect(quiz?.learnerKey).toBe(OWNER_A);
  });
});

describe('a claim carries the binding to the account', () => {
  it('lets the account finish a half-imported course after a retirement mid-run', async () => {
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

  it('lets the account continue after a claim between loads, without a second fresh-id copy', async () => {
    await seedLatestBrowser(storage);
    await server.seedDocument(course(DOCS_COURSE, [{ id: 'theirs', order: 0 }]), OWNER_C);
    server.failWith = (operation, subject) =>
      operation === 'saveDocument' && subject === TABLES_COURSE ? httpError(502, 'BAD') : undefined;
    const first = await runLegacyBrowserImport(server.options(storage));
    expect(first.status).toBe('pending');
    const fresh = freshStageId(DOCS_COURSE, first.ledger!.browserId);

    server.failWith = () => undefined;
    await server.claim(OWNER_A, OWNER_B);
    server.owner = OWNER_B;
    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');
    expect(heldBy(OWNER_B)).toEqual([fresh, TABLES_COURSE].sort());
  });

  it('does not bring back a course the user deleted before the claim', async () => {
    await seedLatestBrowser(storage);
    await server.seedDocument(course(DOCS_COURSE, [{ id: 'theirs', order: 0 }]), OWNER_C);
    server.failWith = (operation, subject) =>
      operation === 'saveDocument' && subject === TABLES_COURSE ? httpError(502, 'BAD') : undefined;
    const first = await runLegacyBrowserImport(server.options(storage));
    const fresh = freshStageId(DOCS_COURSE, first.ledger!.browserId);
    server.deleted.add(fresh);

    server.failWith = () => undefined;
    await server.claim(OWNER_A, OWNER_B);
    server.owner = OWNER_B;
    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');
    expect(server.deleted.has(fresh)).toBe(true);
    expect(heldBy(OWNER_B).filter((id) => !server.deleted.has(id))).toEqual([TABLES_COURSE]);
  });
});

describe('the binding is decided only by a successful bind', () => {
  it('leaves the browser unbound when the bind itself fails', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation) => (operation === 'bind' ? httpError(502, 'BAD') : undefined);
    await runLegacyBrowserImport(server.options(storage));
    expect(server.bindings.size).toBe(0);

    server.failWith = () => undefined;
    server.owner = OWNER_B;
    expect((await runLegacyBrowserImport(at(LATER))).status).toBe('complete');
    expect(heldBy(OWNER_B)).toEqual([DOCS_COURSE, TABLES_COURSE]);
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
    [409, 'LEGACY_IMPORT_NOT_BOUND'],
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
