import { SessionError, type SessionTreeEntry } from '@earendil-works/pi-agent-core';
import {
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
  type WithTransaction,
} from '@openmaic/storage/agent-session/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { AgentSessionEntryStorage } from '@/lib/server/agent-runtime/entry-tree-storage';

const contractUrl = process.env.PG_CONTRACT_URL;

function transactionFor(pool: Pool): WithTransaction {
  return async <T>(body: (queryable: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}

describe.skipIf(!contractUrl)('AgentSessionEntryStorage with PostgreSQL 16', () => {
  let pool: Pool;
  let store: PgAgentSessionStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl });
    await ensureAgentSessionSchema(pool);
    store = new PgAgentSessionStore(pool, { withTransaction: transactionFor(pool) });
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE agent_owner_session_events, agent_owner_session_event_counters, ' +
        'agent_session_entries, agent_session_events, agent_sessions CASCADE',
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('delegates append and path reads to an opened package tree', async () => {
    const session = await store.createSession({
      id: 'adapter-round-trip',
      ownerId: 'anon:test-owner',
      prompt: 'Build a concise lesson.',
    });
    const claim = await store.claimNextSession('worker-a', 101, {
      leaseTtlMs: 10_000,
      maxAttempts: 5,
      sessionId: session.id,
    });
    expect(claim).not.toBeNull();
    const tree = await store.openEntryTree(session.id, 'worker-a', claim!.attempt);
    const storage = AgentSessionEntryStorage.fromHandle(session, tree);
    const first: SessionTreeEntry = {
      type: 'message',
      id: 'entry-one',
      parentId: null,
      timestamp: '2026-08-24T00:00:00.000Z',
      message: { role: 'user', content: 'Start.', timestamp: 1 },
    };
    const second: SessionTreeEntry = {
      type: 'message',
      id: 'entry-two',
      parentId: first.id,
      timestamp: '2026-08-24T00:00:01.000Z',
      message: { role: 'user', content: 'Continue.', timestamp: 2 },
    };

    await storage.appendEntry(first);
    await storage.appendEntry(second);

    await expect(storage.getPathToRoot(second.id)).resolves.toEqual([first, second]);
    await expect(storage.getMetadata()).resolves.toEqual({
      id: session.id,
      createdAt: new Date(session.createdAt).toISOString(),
    });
  });

  it('translates a superseded package lease fence into a pi SessionError', async () => {
    const session = await store.createSession({
      id: 'adapter-lease-loss',
      ownerId: 'anon:test-owner',
      prompt: 'Resume safely.',
    });
    const firstClaim = await store.claimNextSession('worker-a', 101, {
      leaseTtlMs: 10_000,
      maxAttempts: 5,
      sessionId: session.id,
    });
    const staleTree = await store.openEntryTree(session.id, 'worker-a', firstClaim!.attempt);
    const storage = AgentSessionEntryStorage.fromHandle(session, staleTree);
    await store.finishSession(session.id, 'worker-a', { status: 'failed' });
    await store.requeueForRetry(session.id);
    const nextClaim = await store.claimNextSession('worker-b', 202, {
      leaseTtlMs: 10_000,
      maxAttempts: 5,
      sessionId: session.id,
    });
    expect(nextClaim?.attempt).toBe(firstClaim!.attempt + 1);

    const append = storage.appendEntry({
      type: 'message',
      id: 'stale-entry',
      parentId: null,
      timestamp: '2026-08-24T00:00:00.000Z',
      message: { role: 'user', content: 'Do not persist.', timestamp: 1 },
    });

    await expect(append).rejects.toMatchObject({
      name: 'SessionError',
      code: 'storage',
      cause: { name: 'AgentSessionLeaseLostError' },
    } satisfies Partial<SessionError>);
    await expect(staleTree.getEntries()).resolves.toEqual([]);
  });

  it('maps a missing referenced entry to not_found and a corrupt tree to invalid_session', async () => {
    const session = await store.createSession({
      id: 'adapter-code-mapping',
      ownerId: 'anon:test-owner',
      prompt: 'Distinguish error codes.',
    });
    const claim = await store.claimNextSession('worker-a', 101, {
      leaseTtlMs: 10_000,
      maxAttempts: 5,
      sessionId: session.id,
    });
    expect(claim).not.toBeNull();
    const tree = await store.openEntryTree(session.id, 'worker-a', claim!.attempt);
    const storage = AgentSessionEntryStorage.fromHandle(session, tree);
    const root: SessionTreeEntry = {
      type: 'message',
      id: 'code-map-root',
      parentId: null,
      timestamp: '2026-08-24T00:00:00.000Z',
      message: { role: 'user', content: 'Start.', timestamp: 1 },
    };
    await storage.appendEntry(root);

    // A caller-referenced entry that is not in the tree is not_found...
    await expect(storage.setLeafId('missing-target')).rejects.toMatchObject({
      name: 'SessionError',
      code: 'not_found',
    });
    await expect(storage.getPathToRoot('missing-leaf')).rejects.toMatchObject({
      name: 'SessionError',
      code: 'not_found',
    });

    // ...while a tree whose own leaf pointer dangles is invalid_session.
    await storage.appendEntry({
      type: 'leaf',
      id: 'code-map-leaf',
      parentId: root.id,
      timestamp: '2026-08-24T00:00:01.000Z',
      targetId: 'ghost-leaf',
    });
    await expect(storage.getLeafId()).rejects.toMatchObject({
      name: 'SessionError',
      code: 'invalid_session',
    });
  });
});
