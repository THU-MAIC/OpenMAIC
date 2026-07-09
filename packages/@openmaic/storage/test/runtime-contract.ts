// Implementation-agnostic contract for `RuntimeStore`. Every backend is proven
// equivalent by running this same suite against it, so a new backend cannot
// silently diverge from the store's semantics.
//
// Backend-specific behaviours live in the backend's own test file, not here:
// seeding raw rows (migrate-on-read, future-stamp skew) and — mirroring how
// document-contract handles injected scene validators — building a store with
// non-default options (`payloadValidators` overrides).
import { describe, expect, test } from 'vitest';
import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';
import type { RuntimeRecordInit } from '@openmaic/dsl';
import type { RuntimeStore, RuntimeSessionInit } from '../src/index.js';

// --- fixtures ---------------------------------------------------------------

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:01:00.000Z';

/** A valid session init (the pre-stamp shape `createSession` takes). */
export function makeSession(overrides: Partial<RuntimeSessionInit> = {}): RuntimeSessionInit {
  return {
    id: 'sess-1',
    kind: 'chat',
    stageId: 'stage-1',
    learnerKey: 'anon:device-1',
    status: 'active',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

// Deterministic id counter: fixture ids must be unique per call (records are
// append-only under one session) but stable across runs — no randomness.
let recordCounter = 0;

/** A valid record init (the pre-`seq` shape `appendRecord` takes). */
export function makeRecordInit(
  sessionId: string,
  overrides: Record<string, unknown> = {},
): RuntimeRecordInit {
  recordCounter += 1;
  return {
    id: `rec-${recordCounter}`,
    sessionId,
    createdAt: T1,
    payload: { role: 'user', content: 'hello' },
    ...overrides,
  } as RuntimeRecordInit;
}

// --- contract ---------------------------------------------------------------

export function runRuntimeStoreContract(name: string, makeStore: () => RuntimeStore): void {
  describe(`RuntimeStore contract: ${name}`, () => {
    describe('sessions', () => {
      test('createSession stamps the runtime version; getSession round-trips it', async () => {
        const store = makeStore();
        const created = await store.createSession(makeSession());
        expect(created.runtimeDslVersion).toBe(RUNTIME_DSL_VERSION);
        expect(created).toMatchObject(makeSession());

        const loaded = await store.getSession('sess-1');
        expect(loaded).toEqual(created);
      });

      test('createSession rejects a duplicate id — creating twice is a caller bug', async () => {
        const store = makeStore();
        await store.createSession(makeSession());
        await expect(store.createSession(makeSession())).rejects.toThrow(/already exists/);
      });

      test('createSession rejects an invalid envelope and stores nothing', async () => {
        const store = makeStore();
        await expect(store.createSession(makeSession({ learnerKey: '' }))).rejects.toThrow(
          /learnerKey/,
        );
        expect(await store.getSession('sess-1')).toBeUndefined();
      });

      test('getSession resolves undefined for an absent id', async () => {
        const store = makeStore();
        expect(await store.getSession('nope')).toBeUndefined();
      });

      test('listSessions returns only the (stageId, learnerKey) partition, ordered by createdAt', async () => {
        const store = makeStore();
        // Insert the later-created session first: order must come from
        // `createdAt`, not insertion order.
        await store.createSession(makeSession({ id: 'a2', createdAt: T1, updatedAt: T1 }));
        await store.createSession(makeSession({ id: 'a1' }));
        await store.createSession(makeSession({ id: 'b1', learnerKey: 'anon:device-2' }));
        await store.createSession(makeSession({ id: 'c1', stageId: 'stage-2' }));

        const partition = await store.listSessions('stage-1', 'anon:device-1');
        expect(partition.map((s) => s.id)).toEqual(['a1', 'a2']);
        // isolation both ways: other learner, other stage
        expect((await store.listSessions('stage-1', 'anon:device-2')).map((s) => s.id)).toEqual([
          'b1',
        ]);
        expect((await store.listSessions('stage-2', 'anon:device-1')).map((s) => s.id)).toEqual([
          'c1',
        ]);
      });

      test('listSessions orders by the instant a timestamp denotes, not by the string', async () => {
        const store = makeStore();
        // As strings the Z form sorts first ('2025-…' < '2026-…'); as instants
        // the offset form is earlier (2026-01-01T00:30+02:00 = 2025-12-31T22:30Z).
        await store.createSession(
          makeSession({
            id: 'zulu',
            createdAt: '2025-12-31T23:00:00Z',
            updatedAt: '2025-12-31T23:00:00Z',
          }),
        );
        await store.createSession(
          makeSession({
            id: 'offset',
            createdAt: '2026-01-01T00:30:00+02:00',
            updatedAt: '2026-01-01T00:30:00+02:00',
          }),
        );
        expect((await store.listSessions('stage-1', 'anon:device-1')).map((s) => s.id)).toEqual([
          'offset',
          'zulu',
        ]);
      });

      test('setSessionStatus transitions active → completed with the supplied updatedAt', async () => {
        const store = makeStore();
        await store.createSession(makeSession());
        await store.setSessionStatus('sess-1', 'completed', T1);

        const loaded = await store.getSession('sess-1');
        expect(loaded!.status).toBe('completed');
        expect(loaded!.updatedAt).toBe(T1);
      });

      test('setSessionStatus rejects an absent session', async () => {
        const store = makeStore();
        await expect(store.setSessionStatus('ghost', 'completed', T1)).rejects.toThrow(
          /no session/i,
        );
      });

      test('deleteSession removes the session and its records; idempotent', async () => {
        const store = makeStore();
        await store.createSession(makeSession());
        await store.appendRecord(makeRecordInit('sess-1'));
        await store.deleteSession('sess-1');

        expect(await store.getSession('sess-1')).toBeUndefined();
        expect(await store.listRecords('sess-1')).toEqual([]);
        await expect(store.deleteSession('sess-1')).resolves.toBeUndefined();
      });
    });

    describe('records', () => {
      test('appendRecord assigns monotonic seq from 0 and stamps nothing on the record', async () => {
        const store = makeStore();
        await store.createSession(makeSession());
        const r0 = await store.appendRecord(makeRecordInit('sess-1'));
        const r1 = await store.appendRecord(makeRecordInit('sess-1'));
        const r2 = await store.appendRecord(makeRecordInit('sess-1'));

        expect([r0.seq, r1.seq, r2.seq]).toEqual([0, 1, 2]);
        // records ride the parent session's version — no stamp of their own
        expect('runtimeDslVersion' in r0).toBe(false);
      });

      test('appendRecord round-trips a null payload and rejects an undefined one', async () => {
        const store = makeStore();
        await store.createSession(makeSession({ kind: 'playback' }));
        const stored = await store.appendRecord(makeRecordInit('sess-1', { payload: null }));
        expect(stored.payload).toBeNull();
        expect((await store.listRecords('sess-1'))[0]!.payload).toBeNull();

        await expect(
          store.appendRecord(makeRecordInit('sess-1', { payload: undefined })),
        ).rejects.toThrow(/payload/);
      });

      test('appendRecord rejects an absent parent and a non-active parent', async () => {
        const store = makeStore();
        await expect(store.appendRecord(makeRecordInit('ghost'))).rejects.toThrow(/no session/i);

        await store.createSession(makeSession());
        await store.setSessionStatus('sess-1', 'completed', T1);
        await expect(store.appendRecord(makeRecordInit('sess-1'))).rejects.toThrow(/active/);
      });

      test('appendRecord validates skeleton payloads for skeleton kinds by default', async () => {
        const store = makeStore();
        await store.createSession(makeSession()); // kind: 'chat'
        await expect(
          store.appendRecord(makeRecordInit('sess-1', { payload: { role: 'user', content: 'x' } })),
        ).resolves.toMatchObject({ seq: 0 });
        // a quiz-shaped payload on a chat session fails the chat skeleton guard
        await expect(
          store.appendRecord(makeRecordInit('sess-1', { payload: { phase: 'draft' } })),
        ).rejects.toThrow(/payload/);

        // `playback` has no DSL skeleton: an arbitrary object payload is accepted
        await store.createSession(makeSession({ id: 'sess-2', kind: 'playback' }));
        await expect(
          store.appendRecord(makeRecordInit('sess-2', { payload: { position: 42 } })),
        ).resolves.toMatchObject({ seq: 0 });
      });

      // Injected `payloadValidators` overrides need a store built with
      // non-default options, which this factory cannot express — they are
      // covered in the backend's own test file (as document-contract does for
      // injected scene validators).

      test('listRecords orders by seq and narrows to anchored records with { sceneId }', async () => {
        const store = makeStore();
        await store.createSession(makeSession({ kind: 'playback' }));
        const a = await store.appendRecord(
          makeRecordInit('sess-1', { sceneId: 'scene-1', payload: { n: 0 } }),
        );
        const b = await store.appendRecord(
          makeRecordInit('sess-1', { sceneId: 'scene-2', payload: { n: 1 } }),
        );
        const c = await store.appendRecord(
          makeRecordInit('sess-1', { sceneId: 'scene-1', payload: { n: 2 } }),
        );
        const unanchored = await store.appendRecord(
          makeRecordInit('sess-1', { payload: { n: 3 } }),
        );

        const all = await store.listRecords('sess-1');
        expect(all.map((r) => r.id)).toEqual([a.id, b.id, c.id, unanchored.id]);

        const anchored = await store.listRecords('sess-1', { sceneId: 'scene-1' });
        // only records anchored to scene-1; the un-anchored record is excluded
        expect(anchored.map((r) => r.id)).toEqual([a.id, c.id]);
      });
    });

    describe('learner ops', () => {
      test('mergeLearner re-keys every session of the source learner across all stages', async () => {
        const store = makeStore();
        await store.createSession(makeSession({ id: 'from-1' }));
        await store.createSession(makeSession({ id: 'from-2', stageId: 'stage-2' }));
        await store.createSession(makeSession({ id: 'kept', learnerKey: 'user:42' }));

        const moved = await store.mergeLearner('anon:device-1', 'user:42');
        expect(moved).toBe(2);

        // the target learner now owns both partitions, existing sessions untouched
        expect((await store.listSessions('stage-1', 'user:42')).map((s) => s.id).sort()).toEqual([
          'from-1',
          'kept',
        ]);
        expect((await store.listSessions('stage-2', 'user:42')).map((s) => s.id)).toEqual([
          'from-2',
        ]);
        expect(await store.listSessions('stage-1', 'anon:device-1')).toEqual([]);

        // idempotent: a second run finds nothing to move
        expect(await store.mergeLearner('anon:device-1', 'user:42')).toBe(0);
      });

      test('mergeLearner rejects empty learner keys', async () => {
        const store = makeStore();
        // a merge is a write: keys createSession would reject must not be
        // written by the merge either
        await expect(store.mergeLearner('', 'user:42')).rejects.toThrow(/non-empty/);
        await expect(store.mergeLearner('anon:device-1', '')).rejects.toThrow(/non-empty/);
      });

      test('a self-merge moves nothing and returns 0, repeatably', async () => {
        const store = makeStore();
        await store.createSession(makeSession());
        expect(await store.mergeLearner('anon:device-1', 'anon:device-1')).toBe(0);
        expect(await store.mergeLearner('anon:device-1', 'anon:device-1')).toBe(0);
        // the session is untouched under its original key
        expect((await store.listSessions('stage-1', 'anon:device-1')).map((s) => s.id)).toEqual([
          'sess-1',
        ]);
      });

      test('deleteLearnerRuntime removes exactly one learner on one stage; idempotent', async () => {
        const store = makeStore();
        await store.createSession(makeSession({ id: 'target' }));
        await store.appendRecord(makeRecordInit('target'));
        await store.createSession(makeSession({ id: 'other-learner', learnerKey: 'user:42' }));
        await store.createSession(makeSession({ id: 'other-stage', stageId: 'stage-2' }));

        await store.deleteLearnerRuntime('stage-1', 'anon:device-1');
        expect(await store.getSession('target')).toBeUndefined();
        expect(await store.listRecords('target')).toEqual([]);
        // other learner and other stage survive
        expect(await store.getSession('other-learner')).toBeDefined();
        expect(await store.getSession('other-stage')).toBeDefined();

        await expect(
          store.deleteLearnerRuntime('stage-1', 'anon:device-1'),
        ).resolves.toBeUndefined();
      });

      test('deleteStageRuntime removes every learner on the stage; other stages survive', async () => {
        const store = makeStore();
        await store.createSession(makeSession({ id: 's1' }));
        await store.appendRecord(makeRecordInit('s1'));
        await store.createSession(makeSession({ id: 's2', learnerKey: 'user:42' }));
        await store.createSession(makeSession({ id: 's3', stageId: 'stage-2' }));

        await store.deleteStageRuntime('stage-1');
        expect(await store.getSession('s1')).toBeUndefined();
        expect(await store.getSession('s2')).toBeUndefined();
        expect(await store.listRecords('s1')).toEqual([]);
        expect(await store.getSession('s3')).toBeDefined();

        await expect(store.deleteStageRuntime('stage-1')).resolves.toBeUndefined();
      });
    });

    describe('version line', () => {
      test('a stored session carries the runtime stamp only — never a dslVersion key', async () => {
        const store = makeStore();
        await store.createSession(makeSession());
        const stored = await store.getSession('sess-1');
        expect(stored!.runtimeDslVersion).toBe(RUNTIME_DSL_VERSION);
        // the document line's stamp must not leak onto the runtime line
        expect('dslVersion' in stored!).toBe(false);
      });
    });
  });
}
