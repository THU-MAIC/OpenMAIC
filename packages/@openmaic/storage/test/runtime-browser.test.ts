import { describe, expect, test } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RUNTIME_DSL_VERSION_KEY } from '@openmaic/dsl';
import { BrowserRuntimeStore } from '../src/index.js';
import { makeRecordInit, makeSession, runRuntimeStoreContract } from './runtime-contract.js';

// Each store gets its own in-memory IndexedDB factory so contract cases stay
// isolated without leaning on an ambient global.
runRuntimeStoreContract(
  'BrowserRuntimeStore',
  () => new BrowserRuntimeStore({ indexedDB: new IDBFactory() }),
);

// --- backend-specific: version-skew behaviours need to seed a raw session row
// at a foreign version, which the public API (the store always stamps the
// current version) can't express. Mirrors the document backend's reStampStage. ---

// Open the raw DB the store uses and rewrite one stored session row in place,
// simulating a row written by another (older / newer / broken) client.
async function rewriteSessionRow(
  idb: IDBFactory,
  dbName: string,
  sessionId: string,
  rewrite: (row: Record<string, unknown>) => void,
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(dbName);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    const get = store.get(sessionId);
    get.onsuccess = () => {
      const row = get.result as Record<string, unknown>;
      rewrite(row);
      store.put(row);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// Overwrite the session row's version stamp. `version: undefined` DELETES the
// stamp — a corrupt row no producer can write.
async function reStampSession(
  idb: IDBFactory,
  dbName: string,
  sessionId: string,
  version: string | undefined,
): Promise<void> {
  await rewriteSessionRow(idb, dbName, sessionId, (row) => {
    if (version === undefined) delete row[RUNTIME_DSL_VERSION_KEY];
    else row[RUNTIME_DSL_VERSION_KEY] = version;
  });
}

describe('BrowserRuntimeStore migrate-on-read', () => {
  test('a below-epoch stamp fails loud on read (no ladder path)', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-runtime-stale';
    const store = new BrowserRuntimeStore({ indexedDB: idb, dbName });
    await store.createSession(makeSession());
    await reStampSession(idb, dbName, 'sess-1', '0.0.9');

    // '0.0.9' predates the runtime line's pinned initial version, so no ladder
    // will EVER have a path from it — the runtime line has no unversioned
    // epoch, and its migrations start at the pinned first shipped version.
    // This below-epoch fail-loud case therefore stays valid forever. When the
    // first real runtime migration lands, ADD a new test seeding the pinned
    // initial version and asserting the lift (mirroring the document backend's
    // legacy-stamp test) — do not repurpose this one.
    await expect(store.getSession('sess-1')).rejects.toThrow(/no migration path/);
  });
});

describe('BrowserRuntimeStore forward-compatibility', () => {
  test('a future-stamped session reads through unchanged but rejects writes', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-runtime-future';
    const store = new BrowserRuntimeStore({ indexedDB: idb, dbName });
    await store.createSession(makeSession());
    await reStampSession(idb, dbName, 'sess-1', '9.9.9');

    // Read never downgrades: the newer-shaped row survives for the next
    // compatible reader.
    const loaded = await store.getSession('sess-1');
    expect(loaded!.runtimeDslVersion).toBe('9.9.9');

    // ...but an older client must not mutate newer-versioned data.
    await expect(store.appendRecord(makeRecordInit('sess-1'))).rejects.toThrow(
      /newer than this client/,
    );
    await expect(
      store.setSessionStatus('sess-1', 'completed', '2026-01-01T00:01:00.000Z'),
    ).rejects.toThrow(/newer than this client/);
  });
});

describe('BrowserRuntimeStore injected payload validators', () => {
  test('payloadValidators: {} replaces (not merges) the default skeleton gate', async () => {
    const store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      payloadValidators: {},
    });
    await store.createSession(makeSession()); // kind: 'chat'
    // A non-skeleton chat payload — rejected by the default map (see the
    // contract suite), accepted once the app owns the whole mapping.
    await expect(
      store.appendRecord(makeRecordInit('sess-1', { payload: { phase: 'draft' } })),
    ).resolves.toMatchObject({ seq: 0 });
  });

  test('a custom validator gates its kind with its own message', async () => {
    const store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      payloadValidators: {
        playback: (p) =>
          typeof p === 'object' && p !== null && 'position' in p
            ? { valid: true }
            : {
                valid: false,
                errors: [{ path: '/payload', message: 'playback payload requires a position' }],
              },
      },
    });
    await store.createSession(makeSession({ kind: 'playback' }));
    await expect(
      store.appendRecord(makeRecordInit('sess-1', { payload: { position: 1 } })),
    ).resolves.toMatchObject({ seq: 0 });
    await expect(
      store.appendRecord(makeRecordInit('sess-1', { payload: { note: 'x' } })),
    ).rejects.toThrow(/playback payload requires a position/);
  });
});

describe('BrowserRuntimeStore corrupt rows', () => {
  test('a raw row missing its runtime stamp fails loud on read', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-runtime-unstamped';
    const store = new BrowserRuntimeStore({ indexedDB: idb, dbName });
    await store.createSession(makeSession());
    await reStampSession(idb, dbName, 'sess-1', undefined); // strip the stamp

    // The runtime line has no unversioned epoch: sessions are born stamped, so
    // an unstamped stored row is corruption (or a misrouted document-line
    // aggregate), never legacy data — it fails loud instead of resurrecting
    // silently at some guessed version.
    await expect(store.getSession('sess-1')).rejects.toThrow(/no unversioned epoch/);
  });

  test('writes against a stamp-stripped row fail loud too', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-runtime-unstamped-writes';
    const store = new BrowserRuntimeStore({ indexedDB: idb, dbName });
    await store.createSession(makeSession());
    await reStampSession(idb, dbName, 'sess-1', undefined);

    // The write guards read the stored row's version first, so a corrupt stamp
    // surfaces the runtime line's own error rather than being written through.
    await expect(
      store.setSessionStatus('sess-1', 'completed', '2026-01-01T00:01:00.000Z'),
    ).rejects.toThrow(/no unversioned epoch/);
    await expect(store.appendRecord(makeRecordInit('sess-1'))).rejects.toThrow(
      /no unversioned epoch/,
    );
  });

  test('a version-valid row with a corrupt envelope fails loud on direct read', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-runtime-corrupt-envelope';
    const store = new BrowserRuntimeStore({ indexedDB: idb, dbName });
    await store.createSession(makeSession());
    // The stamp stays valid; another field is corrupted — version resolution
    // alone would wave this row through.
    await rewriteSessionRow(idb, dbName, 'sess-1', (row) => {
      row.createdAt = 'not-iso';
    });

    await expect(store.getSession('sess-1')).rejects.toThrow(/createdAt/);
  });

  test('envelope-corrupt rows are omitted from listings like version-corrupt ones', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-runtime-corrupt-envelope-listing';
    const store = new BrowserRuntimeStore({ indexedDB: idb, dbName });
    await store.createSession(makeSession({ id: 'h1' }));
    await store.createSession(makeSession({ id: 'h2' }));
    await store.createSession(makeSession({ id: 'bad-created' }));
    await store.createSession(makeSession({ id: 'bad-status' }));
    await rewriteSessionRow(idb, dbName, 'bad-created', (row) => {
      row.createdAt = 'not-iso';
    });
    await rewriteSessionRow(idb, dbName, 'bad-status', (row) => {
      row.status = 'paused';
    });

    // Corrupt-row tolerance covers the whole envelope, not just the stamp.
    expect((await store.listSessions('stage-1', 'anon:device-1')).map((s) => s.id)).toEqual([
      'h1',
      'h2',
    ]);
  });

  test('a corrupt row is omitted from listings but stays loud on direct read', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-runtime-tolerant-listing';
    const store = new BrowserRuntimeStore({ indexedDB: idb, dbName });
    await store.createSession(makeSession({ id: 'h1' }));
    await store.createSession(makeSession({ id: 'h2' }));
    await store.createSession(makeSession({ id: 'corrupt' }));
    await reStampSession(idb, dbName, 'corrupt', undefined);

    // One poison row must not make the whole partition unenumerable: listings
    // tolerate corrupt rows by omission (the listDocuments precedent), while a
    // direct read stays fail-loud and the delete paths remain the cleanup tool.
    expect((await store.listSessions('stage-1', 'anon:device-1')).map((s) => s.id)).toEqual([
      'h1',
      'h2',
    ]);
    await expect(store.getSession('corrupt')).rejects.toThrow(/no unversioned epoch/);
  });
});

describe('BrowserRuntimeStore mergeLearner guards', () => {
  test('a sibling-stamped row aborts the whole merge atomically', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-runtime-merge-poison';
    const store = new BrowserRuntimeStore({ indexedDB: idb, dbName });
    // 'a-healthy' sorts before 'z-poison' in the index walk, so its re-key is
    // written first and the poison row's throw must roll it back.
    await store.createSession(makeSession({ id: 'a-healthy' }));
    await store.createSession(makeSession({ id: 'z-poison' }));
    await store.createSession(makeSession({ id: 'existing', learnerKey: 'user:42' }));
    // Sibling-stamped: the document line's stamp present, the runtime line's
    // absent — the undecidable cross-line state the version readers reject.
    await rewriteSessionRow(idb, dbName, 'z-poison', (row) => {
      delete row[RUNTIME_DSL_VERSION_KEY];
      row.dslVersion = '0.1.0';
    });

    await expect(store.mergeLearner('anon:device-1', 'user:42')).rejects.toThrow(/misrouted/);
    // Atomic abort: NOTHING moved — the target partition is unchanged and the
    // healthy row is still under the source key (its in-tx re-key rolled back).
    expect((await store.listSessions('stage-1', 'user:42')).map((s) => s.id)).toEqual(['existing']);
    expect((await store.listSessions('stage-1', 'anon:device-1')).map((s) => s.id)).toEqual([
      'a-healthy',
    ]);
  });

  test('a below-epoch stale row aborts the merge with nothing moved', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-runtime-merge-stale';
    const store = new BrowserRuntimeStore({ indexedDB: idb, dbName });
    await store.createSession(makeSession({ id: 'a-healthy' }));
    await store.createSession(makeSession({ id: 'z-stale' }));
    await store.createSession(makeSession({ id: 'existing', learnerKey: 'user:42' }));
    await reStampSession(idb, dbName, 'z-stale', '0.0.9');

    // The merge migrates each stale row in place before re-keying it (the same
    // migrate-in-place semantics as setSessionStatus/appendRecord), so a
    // below-epoch stamp hits the ladder's fail-loud — the same error every
    // path gives it until a real runtime migration lands.
    await expect(store.mergeLearner('anon:device-1', 'user:42')).rejects.toThrow(
      /no migration path/,
    );
    expect((await store.listSessions('stage-1', 'user:42')).map((s) => s.id)).toEqual(['existing']);
    expect((await store.listSessions('stage-1', 'anon:device-1')).map((s) => s.id)).toEqual([
      'a-healthy',
    ]);
  });

  test('a future-stamped row aborts the merge with nothing moved', async () => {
    const idb = new IDBFactory();
    const dbName = 'maic-runtime-merge-future';
    const store = new BrowserRuntimeStore({ indexedDB: idb, dbName });
    await store.createSession(makeSession({ id: 'a-healthy' }));
    await store.createSession(makeSession({ id: 'z-future' }));
    await store.createSession(makeSession({ id: 'existing', learnerKey: 'user:42' }));
    await reStampSession(idb, dbName, 'z-future', '9.9.9');

    // Re-keying is a mutation; a newer client's session must not be mutated.
    await expect(store.mergeLearner('anon:device-1', 'user:42')).rejects.toThrow(
      /newer than this client/,
    );
    expect((await store.listSessions('stage-1', 'user:42')).map((s) => s.id)).toEqual(['existing']);
    // future rows pass through listings unchanged, so both remain visible here
    expect((await store.listSessions('stage-1', 'anon:device-1')).map((s) => s.id)).toEqual([
      'a-healthy',
      'z-future',
    ]);
  });
});
