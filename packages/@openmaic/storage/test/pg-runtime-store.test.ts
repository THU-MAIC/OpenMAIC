import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  PgRuntimeStore,
  ensureSchema,
  type PgRuntimeStoreOptions,
  type QueryResult,
  type Queryable,
} from '../src/runtime/pg.js';
import type { RuntimeStore } from '../src/runtime/types.js';
import { makeRecordInit, makeSession, runRuntimeStoreContract } from './runtime-contract.js';

function transactionOptions(db: PGlite): PgRuntimeStoreOptions {
  return {
    withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
  };
}

function makeBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await ready;
  };
}

const symbolPropertyPayload = { visible: true, [Symbol('hidden')]: 'x' };
const nonEnumerablePropertyPayload = Object.defineProperty({ visible: true }, 'hidden', {
  value: 'x',
  enumerable: false,
});

describe('PgRuntimeStore with PGlite', () => {
  let db: PGlite;
  let store: RuntimeStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureSchema(db);
    store = new PgRuntimeStore(db, transactionOptions(db));
  });

  afterEach(async () => {
    await db.close();
  });

  runRuntimeStoreContract('Postgres (PGlite)', () => store);
});

describe('PgRuntimeStore Postgres behavior', () => {
  let db: PGlite;
  let store: PgRuntimeStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureSchema(db);
    store = new PgRuntimeStore(db, transactionOptions(db));
  });

  afterEach(async () => {
    await db.close();
  });

  test('ensureSchema is idempotent', async () => {
    await expect(ensureSchema(db)).resolves.toBeUndefined();
    await expect(ensureSchema(db)).resolves.toBeUndefined();

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('runtime_sessions', 'runtime_records')
        ORDER BY table_name`,
    );
    expect(tables.rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'runtime_records',
      'runtime_sessions',
    ]);
  });

  test('requires a transaction hook at construction time', () => {
    expect(() => new PgRuntimeStore(db, {} as PgRuntimeStoreOptions)).toThrow(
      /withTransaction.*fresh.*connection.*transaction/i,
    );
  });

  test.each([
    ['Date', new Date('2026-01-01T00:00:00.000Z'), /plain JSON value.*Date/i],
    ['Map', new Map([['key', 'value']]), /plain JSON value.*Map/i],
    ['nested undefined', { nested: { missing: undefined } }, /undefined member.*dropped by JSON/i],
    ['NaN', { value: Number.NaN }, /non-finite number NaN/i],
    ['negative zero', { value: -0 }, /negative zero.*serializes it as 0/i],
    ['symbol-keyed property', symbolPropertyPayload, /symbol-keyed own property.*dropped by JSON/i],
    [
      'non-enumerable property',
      nonEnumerablePropertyPayload,
      /non-enumerable own property.*dropped by JSON/i,
    ],
    [
      'non-index array property',
      Object.assign([1, 2], { meta: 'x' }),
      /non-index own property.*dropped by JSON/i,
    ],
  ])(
    'appendRecord rejects a %s payload with an actionable error',
    async (_name, payload, error) => {
      await store.createSession(makeSession({ kind: 'playback' }));

      await expect(store.appendRecord(makeRecordInit('sess-1', { payload }))).rejects.toThrow(
        error,
      );
    },
  );

  test('appendRecord accepts U+2028 and U+2029 in strings', async () => {
    await store.createSession(makeSession({ kind: 'playback' }));

    await expect(
      store.appendRecord(
        makeRecordInit('sess-1', { payload: { separators: 'line\u2028paragraph\u2029end' } }),
      ),
    ).resolves.toMatchObject({ payload: { separators: 'line\u2028paragraph\u2029end' } });
  });

  test('appendRecord rejects NUL with a human-readable error before PostgreSQL', async () => {
    await store.createSession(makeSession({ kind: 'playback' }));
    const rejection = store.appendRecord(
      makeRecordInit('sess-1', { payload: { value: 'before\u0000after' } }),
    );

    await expect(rejection).rejects.toThrow(/NUL code point/i);
    await expect(rejection).rejects.not.toMatchObject({ code: '22P05' });
  });

  test('createSession rejects an extraneous Date property before PostgreSQL', async () => {
    const init = Object.assign(makeSession(), {
      diagnosticTimestamp: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(store.createSession(init)).rejects.toThrow(/plain JSON value.*Date/i);
    await expect(store.getSession(init.id)).resolves.toBeUndefined();
  });

  test('appendRecord rejects NUL in the record envelope before PostgreSQL', async () => {
    await store.createSession(makeSession({ kind: 'playback' }));
    const rejection = store.appendRecord(
      makeRecordInit('sess-1', { sceneId: 'scene-before\u0000after' }),
    );

    await expect(rejection).rejects.toThrow(/runtime record.*sceneId.*NUL code point/i);
    await expect(rejection).rejects.not.toMatchObject({ code: '22P05' });
  });

  test('appendRecord tolerates an explicit undefined optional anchor like an omitted anchor', async () => {
    await store.createSession(makeSession({ kind: 'playback' }));

    const explicit = await store.appendRecord(
      makeRecordInit('sess-1', { id: 'explicit-undefined', sceneId: undefined }),
    );
    const omitted = await store.appendRecord(makeRecordInit('sess-1', { id: 'omitted-anchor' }));

    expect(explicit).toMatchObject({ id: 'explicit-undefined', seq: 0 });
    expect(omitted).toMatchObject({ id: 'omitted-anchor', seq: 1 });
    const listed = await store.listRecords('sess-1');
    expect(listed.map(({ id, seq }) => ({ id, seq }))).toEqual([
      { id: 'explicit-undefined', seq: 0 },
      { id: 'omitted-anchor', seq: 1 },
    ]);
    expect(listed[0]).not.toHaveProperty('sceneId');
    expect(listed[1]).not.toHaveProperty('sceneId');
  });

  test('rejects an unknown top-level record field that is explicitly undefined', async () => {
    await store.createSession(makeSession({ kind: 'playback' }));
    await expect(
      store.appendRecord({ ...makeRecordInit('sess-1'), ext: undefined } as never),
    ).rejects.toThrow(/undefined member/);
  });

  test.each([
    ['NUL', 'bad\u0000key'],
    ['lone surrogate', 'bad\uD800key'],
  ])(
    'treats %s query and delete keys as absent without leaking PostgreSQL errors',
    async (_, key) => {
      await store.createSession(makeSession({ kind: 'playback' }));
      await store.appendRecord(makeRecordInit('sess-1'));

      await expect(store.getSession(key)).resolves.toBeUndefined();
      await expect(store.listSessions(key, 'anon:device-1')).resolves.toEqual([]);
      await expect(store.listSessions('stage-1', key)).resolves.toEqual([]);
      await expect(store.listRecords(key)).resolves.toEqual([]);
      await expect(store.listRecords('sess-1', { sceneId: key })).resolves.toEqual([]);
      await expect(store.deleteSession(key)).resolves.toBeUndefined();
      await expect(store.deleteLearnerRuntime(key, 'anon:device-1')).resolves.toBeUndefined();
      await expect(store.deleteLearnerRuntime('stage-1', key)).resolves.toBeUndefined();
      await expect(store.deleteStageRuntime(key)).resolves.toBeUndefined();
      await expect(store.mergeLearner(key, 'user:42')).resolves.toBe(0);

      const statusRejection = store.setSessionStatus(key, 'completed', '2026-01-01T00:01:00.000Z');
      await expect(statusRejection).rejects.toThrow(/no session/i);
      await expect(statusRejection).rejects.not.toMatchObject({ code: '22021' });
      await expect(statusRejection).rejects.not.toMatchObject({ code: '22P05' });

      const appendRejection = store.appendRecord(makeRecordInit(key));
      await expect(appendRejection).rejects.toThrow(/no session/i);
      await expect(appendRejection).rejects.not.toMatchObject({ code: '22021' });
      await expect(appendRejection).rejects.not.toMatchObject({ code: '22P05' });

      expect(await store.getSession('sess-1')).toBeDefined();
      expect(await store.listRecords('sess-1')).toHaveLength(1);
    },
  );

  test('mergeLearner rejects a non-JSON target key before PostgreSQL', async () => {
    await store.createSession(makeSession());
    const rejection = store.mergeLearner('anon:device-1', 'user:\uD800');

    await expect(rejection).rejects.toThrow(/target learner key.*unpaired UTF-16 surrogate/i);
    await expect(rejection).rejects.not.toMatchObject({ code: '22P05' });
  });

  test('single-statement deletes do not invoke the transaction hook', async () => {
    let transactionCalls = 0;
    const directDeleteStore = new PgRuntimeStore(db, {
      withTransaction: (body) => {
        transactionCalls += 1;
        return db.transaction((tx: Queryable) => body(tx));
      },
    });
    await directDeleteStore.createSession(makeSession({ id: 'by-id' }));
    await directDeleteStore.createSession(makeSession({ id: 'by-learner' }));
    await directDeleteStore.createSession(makeSession({ id: 'by-stage', learnerKey: 'user:42' }));

    await directDeleteStore.deleteSession('by-id');
    await directDeleteStore.deleteLearnerRuntime('stage-1', 'anon:device-1');
    await directDeleteStore.deleteStageRuntime('stage-1');

    expect(transactionCalls).toBe(0);
  });

  test('deterministically retries two appends interleaved between MAX(seq) and INSERT', async () => {
    const afterMax = makeBarrier(2);
    const beforeInsert = makeBarrier(2);
    let maxReads = 0;
    let inserts = 0;
    const instrumented: Queryable = {
      async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        params?: unknown[],
      ): Promise<QueryResult<TRow>> {
        if (text.includes('SELECT COALESCE(MAX(seq)')) {
          const result = (await db.query(text, params)) as QueryResult<TRow>;
          maxReads += 1;
          if (maxReads <= 2) await afterMax();
          return result;
        }
        if (text.includes('INSERT INTO runtime_records')) {
          inserts += 1;
          if (inserts <= 2) await beforeInsert();
        }
        return (await db.query(text, params)) as QueryResult<TRow>;
      },
    };
    const interleavedStore = new PgRuntimeStore(instrumented, {
      withTransaction: (body) => body(instrumented),
    });
    await interleavedStore.createSession(makeSession({ kind: 'playback' }));

    const appended = await Promise.all([
      interleavedStore.appendRecord(
        makeRecordInit('sess-1', { id: 'interleaved-a', payload: { caller: 'a' } }),
      ),
      interleavedStore.appendRecord(
        makeRecordInit('sess-1', { id: 'interleaved-b', payload: { caller: 'b' } }),
      ),
    ]);

    expect(appended.map((record) => record.seq).sort()).toEqual([0, 1]);
    expect(inserts).toBe(3);
  });

  test.each(['40001', '40P01'])('retries append after PostgreSQL error %s', async (code) => {
    let failed = false;
    const retryableErrorStore = new PgRuntimeStore(db, {
      withTransaction: (body) =>
        db.transaction((tx: Queryable) =>
          body({
            async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
              text: string,
              params?: unknown[],
            ): Promise<QueryResult<TRow>> {
              if (!failed && text.includes('INSERT INTO runtime_records')) {
                failed = true;
                throw Object.assign(new Error(`injected PostgreSQL error ${code}`), { code });
              }
              return tx.query<TRow>(text, params);
            },
          }),
        ),
    });
    await retryableErrorStore.createSession(makeSession({ kind: 'playback' }));

    await expect(
      retryableErrorStore.appendRecord(makeRecordInit('sess-1', { payload: { code } })),
    ).resolves.toMatchObject({ seq: 0 });
  });

  test('concurrent appends assign a gapless, duplicate-free per-session seq', async () => {
    await store.createSession(makeSession({ kind: 'playback' }));

    const appended = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        store.appendRecord(
          makeRecordInit('sess-1', {
            id: `concurrent-${index}`,
            payload: { index },
          }),
        ),
      ),
    );

    const seqs = appended.map((record) => record.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 32 }, (_, index) => index));
    expect(new Set(seqs).size).toBe(32);
    expect((await store.listRecords('sess-1')).map((record) => record.seq)).toEqual(seqs);
  });

  test('mergeLearner is repeatably idempotent and preserves target sessions and records', async () => {
    await store.createSession(makeSession({ id: 'source', kind: 'playback' }));
    await store.appendRecord(
      makeRecordInit('source', { id: 'source-record', payload: { owner: 'source' } }),
    );
    await store.createSession(
      makeSession({ id: 'target', learnerKey: 'user:42', kind: 'playback' }),
    );
    await store.appendRecord(
      makeRecordInit('target', { id: 'target-record', payload: { owner: 'target' } }),
    );

    await expect(store.mergeLearner('anon:device-1', 'user:42')).resolves.toBe(1);
    await expect(store.mergeLearner('anon:device-1', 'user:42')).resolves.toBe(0);
    await expect(store.mergeLearner('anon:device-1', 'user:42')).resolves.toBe(0);

    expect(
      (await store.listSessions('stage-1', 'user:42')).map((session) => session.id).sort(),
    ).toEqual(['source', 'target']);
    expect((await store.listRecords('source')).map((record) => record.id)).toEqual([
      'source-record',
    ]);
    expect((await store.listRecords('target')).map((record) => record.id)).toEqual([
      'target-record',
    ]);
  });

  test('writes fail loud for a future-stamped stored session', async () => {
    const created = await store.createSession(makeSession());
    await db.query('UPDATE runtime_sessions SET data = $2::jsonb WHERE id = $1', [
      created.id,
      JSON.stringify({ ...created, runtimeDslVersion: '99.0.0' }),
    ]);

    await expect(
      store.setSessionStatus(created.id, 'completed', created.updatedAt),
    ).rejects.toThrow(/newer than this client's/);
    await expect(store.appendRecord(makeRecordInit(created.id))).rejects.toThrow(
      /newer than this client's/,
    );
  });

  test('a document-line envelope stored as a session fails loud', async () => {
    const created = await store.createSession(makeSession());
    const { runtimeDslVersion: _runtimeDslVersion, ...withoutRuntimeStamp } = created;
    await db.query('UPDATE runtime_sessions SET data = $2::jsonb WHERE id = $1', [
      created.id,
      JSON.stringify({ ...withoutRuntimeStamp, dslVersion: '0.1.0' }),
    ]);

    await expect(store.getSession(created.id)).rejects.toThrow();
    await expect(store.appendRecord(makeRecordInit(created.id))).rejects.toThrow();
  });

  test('getSession fails loud when a stored row contains JSON null', async () => {
    const created = await store.createSession(makeSession());
    await db.query(`UPDATE runtime_sessions SET data = 'null'::jsonb WHERE id = $1`, [created.id]);

    await expect(store.getSession(created.id)).rejects.toThrow(/corrupt stored row.*"sess-1"/i);
  });
});
