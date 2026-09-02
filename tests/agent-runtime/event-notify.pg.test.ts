/**
 * Agent event NOTIFY delivery — PG contract.
 *
 * Proves the seam that makes token-by-token streaming low-latency: a durable
 * event appended by the REAL `PgAgentSessionStore` wakes the in-process bus
 * through a NOTIFY queued in the SAME transaction, so an SSE tail (or the
 * runner) reacts in the hundreds-of-ms range instead of on the fallback poll.
 *
 * Pinned here, against a REAL PostgreSQL:
 *
 *  1. `createSession` wakes the owner route (session_created projection);
 *  2. `appendControlEvent` (a message_update stand-in) wakes the session
 *     route — this is the cadence that carries text/reasoning deltas;
 *  3. `requestCancel` wakes the session route (runner abort path);
 *  4. the wakeup is delivered only at COMMIT: a rolled-back append must NOT
 *     wake anyone.
 *
 * The bus/global-state and the storage package are the REAL modules; only the
 * wake subscribers are spies.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_SESSION_TABLE_NAMES,
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
  type WithTransaction,
} from '../../packages/@openmaic/storage/src/agent-session/pg';

const contractUrl = process.env.PG_CONTRACT_URL;

function databaseUrl(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

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

describe.skipIf(!contractUrl)('agent event NOTIFY delivery', () => {
  const CONTRACT_DB = `openmaic_event_notify_${process.pid}`;
  const url = contractUrl!;
  let pool: Pool;
  let store: PgAgentSessionStore;
  let withTransaction: WithTransaction;
  let notify: typeof import('@/lib/server/agent-runtime/event-notify-bus').notifyDurableAgentEvent;
  let sessionWake: ReturnType<typeof import('vitest').vi.fn<() => void>>;
  let ownerWake: ReturnType<typeof import('vitest').vi.fn<() => void>>;
  let stopBus: () => Promise<void>;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: url, max: 2 });
    await admin.query(`DROP DATABASE IF EXISTS ${CONTRACT_DB}`);
    await admin.query(`CREATE DATABASE ${CONTRACT_DB}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl(url, CONTRACT_DB), max: 4 });
    await ensureAgentSessionSchema(pool);
    withTransaction = transactionFor(pool);

    // The bus builds its dedicated LISTEN client from DATABASE_URL; point it
    // at this test's database so the wakeups land here.
    process.env.DATABASE_URL = databaseUrl(url, CONTRACT_DB);
    const bus = await import('@/lib/server/agent-runtime/event-notify-bus');
    const handle = bus.startAgentEventNotifyBus();
    stopBus = () => handle.stop();
    await handle.connecting;

    const { vi } = await import('vitest');
    sessionWake = vi.fn<() => void>();
    ownerWake = vi.fn<() => void>();
    bus.subscribeAgentEventWakeup({ kind: 'session', sessionId: 'session-notify' }, sessionWake);
    bus.subscribeAgentEventWakeup({ kind: 'owner', ownerId: 'owner-notify' }, ownerWake);
    notify = bus.notifyDurableAgentEvent;

    // Wire the same hooks `lib/server/agent-runtime/store.ts` wires: every
    // event append / owner projection / cancel queues the lossy NOTIFY in the
    // append transaction.
    store = new PgAgentSessionStore(pool, {
      withTransaction,
      tableNames: DEFAULT_AGENT_SESSION_TABLE_NAMES,
      onSessionEventAppended: (tx, event) =>
        notify(tx, { kind: 'session', sessionId: event.sessionId }),
      onOwnerEventAppended: (tx, event) => notify(tx, { kind: 'owner', ownerId: event.ownerId }),
      onCancelRequested: (tx, sessionId) => notify(tx, { kind: 'session', sessionId }),
    });
  }, 120_000);

  afterAll(async () => {
    await stopBus?.();
    delete process.env.DATABASE_URL;
    await pool?.end();
    const admin = new Pool({ connectionString: url, max: 2 });
    await admin.query(`DROP DATABASE IF EXISTS ${CONTRACT_DB} WITH (FORCE)`);
    await admin.end();
  }, 60_000);

  async function waitForWake(spy: typeof sessionWake, expectedCalls: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (spy.mock.calls.length < expectedCalls) {
      if (Date.now() >= deadline) {
        throw new Error(
          `expected ${expectedCalls} wake(s), saw ${spy.mock.calls.length} within the timeout`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('wakes the owner route on session creation', async () => {
    await store.createSession({
      id: 'session-notify',
      ownerId: 'owner-notify',
      prompt: 'Build a lesson',
      stageId: 'stage-1',
    });
    await waitForWake(ownerWake, 1);
    expect(ownerWake).toHaveBeenCalledTimes(1);
  });

  it('wakes the session route on every event append (the delta cadence)', async () => {
    await store.appendControlEvent('session-notify', {
      ts: Date.now(),
      type: 'message_update',
      data: { text: 'delta' },
    });
    await waitForWake(sessionWake, 1);
    expect(sessionWake).toHaveBeenCalledTimes(1);
  });

  it('wakes the session route on requestCancel (the runner abort path)', async () => {
    await store.requestCancel('session-notify');
    await waitForWake(sessionWake, 2);
    expect(sessionWake).toHaveBeenCalledTimes(2);
  });

  it('never wakes on a rolled-back append (NOTIFY delivers only at commit)', async () => {
    const before = sessionWake.mock.calls.length;
    await expect(
      withTransaction(async (tx) => {
        // The same statement insertEvent runs, with the same transactional
        // wakeup — then the transaction rolls back.
        await tx.query(
          `INSERT INTO agent_session_events (session_id, seq, ts, attempt, type, data)
           SELECT $1, COALESCE(MAX(seq), 0) + 1, 1, 1, 'message_update', '{}'::jsonb
           FROM agent_session_events WHERE session_id = $1 RETURNING seq`,
          ['session-notify'],
        );
        await notify(tx, { kind: 'session', sessionId: 'session-notify' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    // Give a misdelivered notification a window to arrive, then assert silence.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sessionWake).toHaveBeenCalledTimes(before);
  });
});
