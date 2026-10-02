import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureAgentSessionSchema,
  PgAgentSessionStore,
  type Queryable,
  type WithTransaction,
} from '../../packages/@openmaic/storage/src/agent-session/pg';
import { readPriorRunRecord } from '@/lib/server/agent-runtime/entry-tree-storage';

const contractUrl = process.env.PG_CONTRACT_URL;

function transactionFor(pool: Pool): WithTransaction {
  return async (body) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client as Queryable);
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

/**
 * The runner's reading of earlier runs against the real event log: a run that
 * failed while starting leaves lifecycle frames and no completed message, and
 * the user messages around it keep their order relative to the first run.
 */
describe.skipIf(!contractUrl)('prior runs read from the PostgreSQL event log', () => {
  const claimOptions = { leaseTtlMs: 10_000, maxAttempts: 5 };
  let pool: Pool;
  let store: PgAgentSessionStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl });
    await ensureAgentSessionSchema(pool as Queryable);
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE agent_session_entries, agent_session_events,
                agent_owner_session_events, agent_owner_session_event_counters,
                agent_sessions CASCADE`,
    );
    store = new PgAgentSessionStore(pool as Queryable, { withTransaction: transactionFor(pool) });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('tells a failed start from a run that completed messages', async () => {
    // Created with opening context: terminal until its opening message lands.
    await store.createSession({
      id: 'failed-start',
      ownerId: 'owner',
      prompt: 'Move this course into a folder',
      stageId: 'stage',
      status: 'succeeded',
    });
    await store.postUserMessage('failed-start', { text: 'Move this course into a folder' });
    expect(await readPriorRunRecord(store, 'failed-start')).toEqual({
      firstRunSeq: null,
      completedMessages: false,
    });

    // The first run fails while resolving its model: start frame, then failure.
    const first = await store.claimNextSession('worker-1', 1, claimOptions);
    expect(first?.id).toBe('failed-start');
    const startSeq = await store.appendRunEvent('failed-start', 'worker-1', {
      ts: Date.now(),
      attempt: first!.attempt,
      type: 'session_start',
      data: { prompt: 'Move this course into a folder' },
    });
    await store.appendRunEvent('failed-start', 'worker-1', {
      ts: Date.now(),
      attempt: first!.attempt,
      type: 'session_end',
      data: { status: 'failed', error: 'model unavailable' },
    });
    expect(
      await store.finishSession('failed-start', 'worker-1', {
        status: 'failed',
        error: 'model unavailable',
        expectedAttempt: first!.attempt,
      }),
    ).toBe(true);
    await store.postUserMessage('failed-start', { text: 'Please try again' });

    const record = await readPriorRunRecord(store, 'failed-start');
    expect(record).toEqual({ firstRunSeq: startSeq, completedMessages: false });
    const messages = await store.listUserMessages('failed-start');
    expect(messages.map((message) => message.seq < record.firstRunSeq!)).toEqual([true, false]);

    // A run that completes a message makes an empty tree a lost one.
    const second = await store.claimNextSession('worker-2', 2, claimOptions);
    expect(second?.id).toBe('failed-start');
    await store.appendRunEvent('failed-start', 'worker-2', {
      ts: Date.now(),
      attempt: second!.attempt,
      type: 'message_end',
      data: { message: { role: 'user', content: 'Move this course into a folder' } },
    });
    expect(await readPriorRunRecord(store, 'failed-start')).toEqual({
      firstRunSeq: startSeq,
      completedMessages: true,
    });
  });
});
