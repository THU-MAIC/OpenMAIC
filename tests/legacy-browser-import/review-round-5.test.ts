/**
 * Review round 5: a dropped asset request stays pending (the real asset
 * client's error shape), a browser another owner holds asks the server only
 * every so often and never opens the old databases, and the read budget
 * counts consecutive failing runs over a real span of time.
 */
import 'fake-indexeddb/auto';

import { HttpAssetStore } from '@openmaic/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OTHER_OWNER_RECHECK_MS, runLegacyBrowserImport } from '@/lib/legacy-browser-import';

import {
  FakeServer,
  MemoryStorage,
  NOW,
  OWNER_A,
  OWNER_B,
  configureSeams,
  freshBrowser,
} from './harness';
import { DOCS_COURSE, TABLES_COURSE, seedLatestBrowser } from './fixtures';

const hooks = vi.hoisted(() => ({
  /** How often the old databases were opened. */
  opened: 0,
  /** Courses whose document-store read always fails. */
  brokenDocuments: new Set<string>(),
}));

vi.mock('@/lib/legacy-browser-storage', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/legacy-browser-storage')>();
  return {
    ...original,
    openLegacyDocumentReader: async () => {
      hooks.opened += 1;
      const reader = await original.openLegacyDocumentReader();
      return (
        reader && {
          ...reader,
          loadDocument: async (id: string) => {
            if (hooks.brokenDocuments.has(id)) {
              throw new DOMException('Failed to read large IndexedDB value', 'DataError');
            }
            return reader.loadDocument(id);
          },
        }
      );
    },
  };
});

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

let storage: MemoryStorage;
let server: FakeServer;
let teardown: () => Promise<void>;

beforeEach(async () => {
  hooks.opened = 0;
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

const at = (time: number) => server.options(storage, { now: () => time });

/** The error the real asset client throws for a request that got no answer. */
async function droppedAssetRequest(kind: 'upload' | 'probe'): Promise<unknown> {
  const store = new HttpAssetStore({
    baseUrl: '/api/persistence',
    probeTimeoutMs: 5,
    fetch: (_input, init) =>
      kind === 'upload'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            ),
          ),
  });
  const error = await (
    kind === 'upload' ? store.put(new Blob(['x'], { type: 'image/png' })) : store.exists('ast_x')
  ).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ status: 0, code: 'HTTP_REQUEST_FAILED' });
  return error;
}

function mediaStatuses(ledger: Awaited<ReturnType<typeof runLegacyBrowserImport>>['ledger']) {
  return Object.values(ledger?.courses ?? {}).flatMap((entry) =>
    Object.values(entry.media ?? {}).map((media) => media.status),
  );
}

describe('a dropped asset request', () => {
  it.each(['upload', 'probe'] as const)(
    'leaves the media pending when the %s gets no answer, and imports it once the network is back',
    async (kind) => {
      await seedLatestBrowser(storage);
      const dropped = await droppedAssetRequest(kind);
      const operation = kind === 'upload' ? 'putAsset' : 'assetExists';
      server.failWith = (called) => (called === operation ? (dropped as Error) : undefined);

      const first = await runLegacyBrowserImport(server.options(storage));
      expect(first.status).toBe('pending');
      expect(mediaStatuses(first.ledger)).not.toContain('failed');
      expect(Object.values(first.ledger!.courses).map((entry) => entry.status)).not.toContain(
        'failed',
      );

      server.failWith = () => undefined;
      const later = await runLegacyBrowserImport(at(NOW + 7 * 24 * HOUR));
      expect(later.status).toBe('complete');
      expect(mediaStatuses(later.ledger)).toEqual([]);
      expect(server.assets.size).toBeGreaterThan(0);
    },
  );
});

describe('a browser another owner holds', () => {
  it('asks the server once per recheck delay and never opens the old databases', async () => {
    await seedLatestBrowser(storage);
    server.failWith = (operation, subject) =>
      operation === 'saveDocument' && subject === TABLES_COURSE
        ? Object.assign(new Error('BAD'), { status: 502, code: 'BAD' })
        : undefined;
    await runLegacyBrowserImport(server.options(storage));
    server.failWith = () => undefined;
    expect(server.bindings.size).toBe(1);

    // B loads five times within the delay.
    server.owner = OWNER_B;
    const start = NOW + 10 * MINUTE;
    const binds = () => server.calls.filter((call) => call.startsWith('bind ')).length;
    const before = binds();
    hooks.opened = 0;
    for (let load = 0; load < 5; load += 1) {
      const outcome = await runLegacyBrowserImport(at(start + load * MINUTE));
      expect(['claimed-by-another-owner', 'deferred']).toContain(outcome.status);
    }
    expect(binds() - before).toBe(1);
    expect(hooks.opened).toBe(0);
    expect(server.stageOwners.get(TABLES_COURSE)).toBeUndefined();

    // A claim moves the binding to the account; once the delay has passed,
    // the account's next load imports the rest.
    await server.claim(OWNER_A, OWNER_B);
    const beforeDelay = await runLegacyBrowserImport(at(start + 5 * MINUTE));
    expect(beforeDelay.status).toBe('deferred');
    const after = await runLegacyBrowserImport(at(start + OTHER_OWNER_RECHECK_MS + MINUTE));
    expect(after.status).toBe('complete');
    expect(server.stageOwners.get(TABLES_COURSE)).toBe(OWNER_B);
    expect(server.stageOwners.get(DOCS_COURSE)).toBe(OWNER_B);
  });

  it('ignores a recheck time a clock that ran ahead wrote', async () => {
    await seedLatestBrowser(storage);
    // A's run binds the browser, then leaves everything pending.
    server.failWith = (operation) =>
      operation === 'fenced:learnerKey'
        ? Object.assign(new Error('x'), { status: 502 })
        : undefined;
    await runLegacyBrowserImport(server.options(storage));
    server.failWith = () => undefined;

    server.owner = OWNER_B;
    const ahead = NOW + 30 * 24 * HOUR;
    expect((await runLegacyBrowserImport(at(ahead))).status).toBe('claimed-by-another-owner');
    // The clock is corrected: the recheck a month ahead does not hold it back.
    expect((await runLegacyBrowserImport(at(NOW + HOUR))).status).toBe('claimed-by-another-owner');
  });
});

describe('the read budget', () => {
  const failingRuns = async (times: number[]) => {
    let outcome: Awaited<ReturnType<typeof runLegacyBrowserImport>> | undefined;
    for (const time of times) outcome = await runLegacyBrowserImport(at(time));
    return outcome!;
  };

  it('does not settle five failing runs within an hour', async () => {
    await seedLatestBrowser(storage);
    hooks.brokenDocuments.add(DOCS_COURSE);
    const outcome = await failingRuns([0, 10, 20, 30, 40, 50].map((m) => NOW + m * MINUTE));
    expect(outcome.ledger?.courses[DOCS_COURSE]?.readFailures?.count).toBeGreaterThanOrEqual(5);
    expect(outcome.ledger?.courses[DOCS_COURSE]?.status).toBe('pending');
  });

  it('does not settle two failing runs more than a day apart', async () => {
    await seedLatestBrowser(storage);
    hooks.brokenDocuments.add(DOCS_COURSE);
    const outcome = await failingRuns([NOW, NOW + 25 * HOUR]);
    expect(outcome.ledger?.courses[DOCS_COURSE]).toMatchObject({
      status: 'pending',
      readFailures: { count: 2 },
    });
  });

  it('counts a first failure from a clock that ran ahead from the next failure', async () => {
    await seedLatestBrowser(storage);
    hooks.brokenDocuments.add(DOCS_COURSE);
    const ahead = NOW + 365 * 24 * HOUR;
    await runLegacyBrowserImport(at(ahead));
    expect(loadLedgerCourse()?.readFailures?.since).toBe(ahead);
    // Corrected clock: four more failures over a day settle the course.
    const outcome = await failingRuns([6, 12, 18, 25].map((h) => NOW + h * HOUR));
    expect(outcome.ledger?.courses[DOCS_COURSE]?.readFailures?.since).toBe(NOW + 6 * HOUR);
    const settled = await runLegacyBrowserImport(at(NOW + 31 * HOUR));
    expect(settled.ledger?.courses[DOCS_COURSE]?.status).toBe('skipped');
  });

  it('starts counting again after a run that read the course', async () => {
    await seedLatestBrowser(storage);
    hooks.brokenDocuments.add(DOCS_COURSE);
    // Keep the course pending after a good read: its narration upload fails.
    await failingRuns([0, 6, 12, 18].map((h) => NOW + h * HOUR));
    expect(loadLedgerCourse()?.readFailures?.count).toBe(4);

    hooks.brokenDocuments.clear();
    server.failWith = (operation) =>
      operation === 'saveDocument' ? Object.assign(new Error('x'), { status: 502 }) : undefined;
    await runLegacyBrowserImport(at(NOW + 20 * HOUR));
    expect(loadLedgerCourse()?.readFailures).toBeUndefined();

    // One failure more, well over a day after the first: not settled.
    server.failWith = () => undefined;
    hooks.brokenDocuments.add(DOCS_COURSE);
    const outcome = await runLegacyBrowserImport(at(NOW + 48 * HOUR));
    expect(outcome.ledger?.courses[DOCS_COURSE]).toMatchObject({
      status: 'pending',
      readFailures: { count: 1 },
    });
  });
});

function loadLedgerCourse() {
  const raw = storage.getItem('maic:legacy-import:v3');
  return raw
    ? (
        JSON.parse(raw) as {
          courses: Record<string, { readFailures?: { count: number; since: number } }>;
        }
      ).courses[DOCS_COURSE]
    : undefined;
}
