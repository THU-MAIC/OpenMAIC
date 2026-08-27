import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  DEFAULT_AGENT_SESSION_TABLE_NAMES,
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type PgAgentSessionStoreOptions,
  type Queryable,
} from '../src/agent-session/pg.js';
import {
  AgentSessionEntryTreeError,
  AgentSessionLeaseLostError,
  AGENT_SESSION_LIFECYCLE,
} from '../src/agent-session/types.js';
import { runAgentSessionConcurrencyContract } from './agent-session-concurrency-contract.js';
import { makeAgentSessionInput, runAgentSessionStoreContract } from './agent-session-contract.js';
import { runAgentSessionUrlContract } from './agent-session-url-contract.js';

function optionsFor(db: PGlite): PgAgentSessionStoreOptions {
  return { withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)) };
}

describe('PgAgentSessionStore with PGlite', () => {
  let db: PGlite;
  let store: PgAgentSessionStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAgentSessionSchema(db);
    store = new PgAgentSessionStore(db, optionsFor(db));
  });

  afterEach(async () => {
    await db.close();
  });

  runAgentSessionStoreContract('Postgres (PGlite)', () => store);
  runAgentSessionConcurrencyContract('Postgres (PGlite)', () => store, {
    genuineConcurrency: false,
  });
  runAgentSessionUrlContract('Postgres (PGlite)', () => store);

  test('provisions all six tables idempotently', async () => {
    await expect(ensureAgentSessionSchema(db)).resolves.toBeUndefined();
    const result = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name`,
      [Object.values(DEFAULT_AGENT_SESSION_TABLE_NAMES)],
    );
    expect(result.rows.map((row) => row.table_name)).toEqual(
      Object.values(DEFAULT_AGENT_SESSION_TABLE_NAMES).sort(),
    );
  });

  test('requires a correctly pinned transaction hook', () => {
    expect(() => new PgAgentSessionStore(db, {} as PgAgentSessionStoreOptions)).toThrow(
      /withTransaction.*fresh.*connection.*transaction/i,
    );
  });

  test('rejects a durable mutation after its lease attempt is superseded', async () => {
    await db.query('CREATE TABLE mutation_probe (value TEXT NOT NULL)');
    await store.createSession(makeAgentSessionInput());
    await store.claimNextSession('worker-a', 101, { leaseTtlMs: 10_000, maxAttempts: 3 });
    await store.finishSession('session-1', 'worker-a', { status: 'failed' });
    await store.requeueForRetry('session-1');
    await store.claimNextSession('worker-b', 202, { leaseTtlMs: 10_000, maxAttempts: 3 });

    await expect(
      db.transaction(async (tx: Queryable) => {
        await store.assertActiveLease('session-1', 'worker-a', 1, tx);
        await tx.query("INSERT INTO mutation_probe (value) VALUES ('stale')");
      }),
    ).rejects.toBeInstanceOf(AgentSessionLeaseLostError);
    const rows = await db.query<{ value: string }>('SELECT value FROM mutation_probe');
    expect(rows.rows).toEqual([]);
  });

  test('runs owner resolution before insertion and creation hook before commit', async () => {
    const observed: string[] = [];
    const hooked = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      resolveFinalOwner: async (tx, ownerId) => {
        const count = await tx.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM agent_sessions',
        );
        observed.push(`resolve:${count.rows[0]!.n}`);
        return `${ownerId}-final`;
      },
      onSessionCreated: async (tx, meta) => {
        const row = await tx.query<{ owner_id: string }>(
          'SELECT owner_id FROM agent_sessions WHERE id = $1',
          [meta.id],
        );
        observed.push(`created:${row.rows[0]!.owner_id}`);
      },
    });

    await hooked.createSession(makeAgentSessionInput());
    expect(observed).toEqual(['resolve:0', 'created:owner-a-final']);
  });

  test('swallows a projection failure without rolling back the business mutation', async () => {
    const logged: unknown[] = [];
    const brokenProjection = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      logger: { error: (...args) => logged.push(args) },
    });
    await db.query(
      `ALTER TABLE agent_owner_session_events
       ADD CONSTRAINT reject_projection CHECK (type <> 'session_created')`,
    );

    await expect(brokenProjection.createSession(makeAgentSessionInput())).resolves.toMatchObject({
      id: 'session-1',
    });
    expect(await brokenProjection.getSession('session-1')).not.toBeNull();
    expect(await brokenProjection.readMaxId('owner-a')).toBe(BigInt(0));
    expect(logged).toHaveLength(1);
  });

  test('lets a throwing onUserMessagePosted veto the message and its requeue', async () => {
    const hooked = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      onUserMessagePosted: async () => {
        throw new Error('host material binding failed');
      },
    });
    await hooked.createSession(makeAgentSessionInput({ status: 'succeeded' }));
    // The hook is a veto point (reference semantics): a throw aborts the whole
    // postUserMessage — the message row is not persisted, the terminal session
    // is not requeued, and the caller receives the error.
    await expect(hooked.postUserMessage('session-1', { text: 'Continue' })).rejects.toThrow(
      'host material binding failed',
    );
    expect(await hooked.listUserMessages('session-1')).toEqual([]);
    expect(await hooked.getSession('session-1')).toMatchObject({ status: 'succeeded' });
    expect(await hooked.readMaxId('owner-a')).toBe(BigInt(1));
  });

  test('treats a resolver-collapsed merge target as a no-op self-merge', async () => {
    const hooked = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      resolveFinalOwner: async (_tx, ownerId) => (ownerId === 'owner-b' ? 'owner-a' : ownerId),
    });
    await hooked.createSession(makeAgentSessionInput());
    await hooked.createSession(makeAgentSessionInput({ id: 'session-2', stageId: 'stage-2' }));
    // toOwnerId resolves back onto fromOwnerId: the merge must be a no-op
    // instead of re-keying sessions to themselves and renumbering the owner's
    // own projection above its high-water mark.
    expect(await hooked.mergeOwner('owner-a', 'owner-b')).toBe(0);
    expect((await hooked.listSessionsByOwner('owner-a')).map((session) => session.id)).toEqual([
      'session-1',
      'session-2',
    ]);
    expect(await hooked.listSessionsByOwner('owner-b')).toEqual([]);
    expect(await hooked.readMaxId('owner-a')).toBe(BigInt(2));
    expect((await hooked.readAfter('owner-a', BigInt(0))).map((event) => event.id)).toEqual([
      '1',
      '2',
    ]);
  });

  test('reads retirement through the host resolver inside a transaction', async () => {
    const hooked = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      resolveFinalOwner: async (_tx, ownerId) =>
        ownerId === 'retired-owner' ? 'current-owner' : ownerId,
    });
    await hooked.createSession(
      makeAgentSessionInput({ id: 'session-1', ownerId: 'current-owner' }),
    );
    expect(await hooked.readRetirement('current-owner')).toBeNull();
    expect(await hooked.readRetirement('retired-owner')).toBe('current-owner');
  });

  test('preserves an empty-string leaf target instead of collapsing it to null', async () => {
    await store.createSession(makeAgentSessionInput());
    await store.claimNextSession('worker-a', 101, { leaseTtlMs: 10_000, maxAttempts: 3 });
    const tree = await store.openEntryTree('session-1', 'worker-a', 1);
    await tree.appendEntry({
      id: 'marker',
      parentId: null,
      type: 'leaf',
      timestamp: '2026-01-01T00:00:00.000Z',
      targetId: '',
    });
    // The '' target is preserved as the leaf id (reference leafIdAfterEntry
    // returns it verbatim), so getLeafId validates it like any other leaf id
    // and finds no entry with id '' — instead of silently returning null.
    await expect(tree.getLeafId()).rejects.toBeInstanceOf(AgentSessionEntryTreeError);
  });

  test('keeps event and tree rows physically present after a tombstone', async () => {
    await store.createSession(makeAgentSessionInput());
    await store.appendControlEvent('session-1', {
      ts: 1,
      type: 'control',
      data: {},
    });
    await store.claimNextSession('worker-a', 101, { leaseTtlMs: 10_000, maxAttempts: 3 });
    const tree = await store.openEntryTree('session-1', 'worker-a', 1);
    await tree.appendEntry({
      id: 'root',
      parentId: null,
      type: 'message',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {},
    });
    await store.softDeleteSession('session-1', 'owner-a');

    expect((await db.query('SELECT 1 FROM agent_session_events')).rows).toHaveLength(1);
    expect((await db.query('SELECT 1 FROM agent_session_entries')).rows).toHaveLength(1);
  });

  test('supports isolated custom table names', async () => {
    const custom = {
      sessions: 'spec_sessions',
      events: 'spec_events',
      entries: 'spec_entries',
      ownerEventCounters: 'spec_owner_event_counters',
      ownerEvents: 'spec_owner_events',
    };
    await ensureAgentSessionSchema(db, custom);
    const customStore = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      tableNames: custom,
    });
    await customStore.createSession(makeAgentSessionInput({ id: 'custom-1' }));
    expect(await customStore.getSession('custom-1')).toMatchObject({ id: 'custom-1' });
    expect(await store.getSession('custom-1')).toBeNull();
    // Index names derive from the table-name substitution verbatim — the
    // template index names are re-keyed by the same replaceAll that re-keys
    // their tables, with no separate prefix rewriting. This pins that the
    // entries index is `spec_entries_type_idx`, never the prefix-derived
    // `spec_session_entries_type_idx` that the old dead rename lines claimed.
    const indexNames = (
      await db.query<{ index_name: string }>(
        `SELECT indexname AS index_name FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
        [['spec_sessions', 'spec_entries']],
      )
    ).rows.map((row) => row.index_name);
    expect(indexNames).toContain('spec_sessions_status_live_idx');
    expect(indexNames).toContain('spec_sessions_owner_live_idx');
    expect(indexNames).toContain('spec_entries_type_idx');
    expect(indexNames).not.toContain('spec_session_entries_type_idx');
  });

  test('settles a cancel-requested stale-running session as cancelled on claim, never attempt N+1', async () => {
    // The incident shape: a worker dies mid-run with the cancel request set;
    // after the restart the claim scan must NOT re-lease the session for
    // attempt 2 — it settles the pending cancel as `cancelled` instead.
    let now = 1_000_000;
    const clocked = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      now: () => now,
    });
    await clocked.createSession(makeAgentSessionInput());
    const first = await clocked.claimNextSession('worker-a', 101, {
      leaseTtlMs: 10_000,
      maxAttempts: 3,
    });
    expect(first).toMatchObject({ id: 'session-1', status: 'running', attempt: 1 });

    await clocked.requestCancel('session-1');
    now += 20_000; // The 10s lease is stale; the worker is gone.

    const retry = await clocked.claimNextSession('worker-b', 102, {
      leaseTtlMs: 10_000,
      maxAttempts: 3,
    });
    expect(retry).toBeNull();

    const meta = await clocked.getSession('session-1');
    expect(meta).toMatchObject({ status: 'cancelled', attempt: 0 });
    expect(meta?.lease).toBeUndefined();
    expect(await clocked.isCancelRequested('session-1')).toBe(false);
    const events = await clocked.readEventsAfter('session-1', 0);
    expect(events.at(-1)).toMatchObject({ type: AGENT_SESSION_LIFECYCLE.sessionEnd });
    expect((events.at(-1)?.data as { status?: unknown } | undefined)?.status).toBe('cancelled');
  });

  test('claim scan settles a cancel-requested session and still claims the next queued one', async () => {
    const clocked = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      now: () => 1_000_000,
    });
    await clocked.createSession(makeAgentSessionInput({ id: 'session-cancel' }));
    await clocked.requestCancel('session-cancel');
    await clocked.createSession(makeAgentSessionInput({ id: 'session-next', stageId: 'stage-2' }));
    // Pin the scan order: the cancel-requested candidate must sort first.
    await db.query(`UPDATE agent_sessions SET created_at = $2 WHERE id = $1`, [
      'session-cancel',
      new Date('2020-01-01T00:00:00Z'),
    ]);
    await db.query(`UPDATE agent_sessions SET created_at = $2 WHERE id = $1`, [
      'session-next',
      new Date('2021-01-01T00:00:00Z'),
    ]);

    const claim = await clocked.claimNextSession('worker-a', 101, {
      leaseTtlMs: 10_000,
      maxAttempts: 3,
    });
    // The scan keeps going after settling the cancel-requested candidate.
    expect(claim?.id).toBe('session-next');
    expect(await clocked.getSession('session-cancel')).toMatchObject({ status: 'cancelled' });
  });

  test('onSessionEventAppended fires inside the append transaction for every writer role', async () => {
    const seen: Array<{ seq: number; type: string; attempt: number; visible: boolean }> = [];
    const hooked = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      onSessionEventAppended: async (tx, event) => {
        // The hook must observe its own row in the same transaction — that is
        // what lets a host queue a NOTIFY that PostgreSQL only delivers at
        // commit, exactly when the row becomes durable.
        const row = await tx.query<{ type: string }>(
          'SELECT type FROM agent_session_events WHERE session_id = $1 AND seq = $2',
          [event.sessionId, event.seq],
        );
        seen.push({
          seq: event.seq,
          type: event.type,
          attempt: event.attempt,
          visible: !!row.rows[0],
        });
      },
    });
    await hooked.createSession(makeAgentSessionInput({ status: 'succeeded' }));
    await hooked.appendUserMessage('session-1', {
      text: 'queued',
      delivery: 'queued',
      clientRequestId: 'c1',
    });
    await hooked.postUserMessage('session-1', { text: 'Continue' });
    await hooked.claimNextSession('worker-a', 101, { leaseTtlMs: 10_000, maxAttempts: 3 });
    await hooked.appendRunEvent('session-1', 'worker-a', {
      ts: 5,
      attempt: 1,
      type: 'message_update',
      data: { text: 'delta' },
    });
    await hooked.appendControlEvent('session-1', { ts: 6, type: 'control', data: {} });

    expect(seen.map((event) => event.type)).toEqual([
      'user_message',
      'user_message',
      'message_update',
      'control',
    ]);
    expect(seen.every((event) => event.visible)).toBe(true);
    // Control-plane events store the current generation under the row lock;
    // run events keep their own attempt.
    expect(seen[2]).toMatchObject({ seq: 3, attempt: 1 });
  });

  test('a throwing onSessionEventAppended aborts the append (transactional NOTIFY semantics)', async () => {
    const hooked = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      onSessionEventAppended: async () => {
        throw new Error('notify payload too large');
      },
    });
    await hooked.createSession(makeAgentSessionInput());
    await expect(
      hooked.appendControlEvent('session-1', { ts: 1, type: 'control', data: {} }),
    ).rejects.toThrow('notify payload too large');
    expect(await hooked.lastEventSeq('session-1')).toBe(0);
  });

  test('onOwnerEventAppended and onCancelRequested fire on their transactions', async () => {
    const ownerEvents: string[] = [];
    const cancels: string[] = [];
    const hooked = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      onOwnerEventAppended: async (_tx, event) => {
        ownerEvents.push(`${event.type}:${event.ownerId}:${event.sessionId}:${event.id}`);
      },
      onCancelRequested: async (_tx, sessionId) => {
        cancels.push(sessionId);
      },
    });
    await hooked.createSession(makeAgentSessionInput());
    expect(ownerEvents).toEqual(['session_created:owner-a:session-1:1']);

    await hooked.requestCancel('session-1');
    expect(cancels).toEqual(['session-1']);
    expect(ownerEvents).toEqual([
      'session_created:owner-a:session-1:1',
      'session_cancel_requested:owner-a:session-1:2',
    ]);
  });

  test('onOwnerEventAppended rolls back with a failed projection, keeping the business write', async () => {
    const hooked = new PgAgentSessionStore(db, {
      ...optionsFor(db),
      onOwnerEventAppended: async () => {
        throw new Error('owner notify failed');
      },
    });
    // The projection failure is logged and non-fatal: the session creation
    // commits, the owner projection (and its queued NOTIFY) rolls back.
    await expect(hooked.createSession(makeAgentSessionInput())).resolves.toMatchObject({
      id: 'session-1',
    });
    expect(await hooked.getSession('session-1')).not.toBeNull();
    expect(await hooked.readMaxId('owner-a')).toBe(BigInt(0));
  });
});
