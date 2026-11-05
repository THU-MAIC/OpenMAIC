import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureAgentSessionSchema,
  PgAgentSessionStore,
  type Queryable,
  type WithTransaction,
} from '../../packages/@openmaic/storage/src/agent-session/pg';

const runtime = vi.hoisted(() => ({ pool: undefined as unknown as Pool, buildAgent: vi.fn() }));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ pool: runtime.pool }),
}));
vi.mock('@/lib/persistence/schema-boot-check', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/persistence/schema-boot-check')>()),
  assertRuntimeSchemaCompatibility: async () => {},
}));
vi.mock('@/lib/agent/runtime/build-agent', () => ({ buildAgent: runtime.buildAgent }));
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { startAgentRunner } from '@/lib/server/agent-runtime/runner';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = `openmaic_park_attempts_${process.pid}`;

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

describe.skipIf(!contractUrl)('session attempt budget takeovers', () => {
  /** The suite's own bound; every claim below tells the store the same value. */
  const maxAttempts = 5;
  /** Mirrors the runner's verdict against this suite's bound, not its config. */
  const overAttemptCap = (claim: { attempt: number }) => claim.attempt > maxAttempts;

  let admin: Pool;
  let pool: Pool;
  let store: PgAgentSessionStore;

  beforeAll(async () => {
    // Keep cleanup and worker claims local to this suite during parallel CI.
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}` });
    await ensureAgentSessionSchema(pool as Queryable);
  });

  beforeEach(async () => {
    // CASCADE absorbs every table that has since gained an FK to agent_sessions
    // (agent_session_urls from the URL trust gate, agent_session_materials from
    // the material store); the suite owns this schema.
    await pool.query(
      `TRUNCATE agent_session_entries, agent_session_events,
                agent_owner_session_events, agent_owner_session_event_counters,
                agent_sessions CASCADE`,
    );
    store = new PgAgentSessionStore(pool as Queryable, { withTransaction: transactionFor(pool) });
  });

  afterAll(async () => {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    } finally {
      await Promise.all([pool?.end(), admin.end()]);
    }
  });

  it('survives six clean park and takeover cycles with a cap of five', async () => {
    await store.createSession({
      id: 'parked-session',
      ownerId: 'owner',
      prompt: 'Keep working',
      stageId: 'stage',
    });

    let claim = await store.claimNextSession('worker-0', 100, {
      leaseTtlMs: 10_000,
      maxAttempts,
    });
    expect(claim).not.toBeNull();
    expect(overAttemptCap(claim!)).toBe(false);

    for (let cycle = 0; cycle < 6; cycle += 1) {
      await store.releaseLease('parked-session', `worker-${cycle}`);
      claim = await store.claimNextSession(`worker-${cycle + 1}`, 101 + cycle, {
        leaseTtlMs: 10_000,
        maxAttempts,
      });
      expect(claim).toMatchObject({ attempt: 1, claimReason: 'orphaned' });
      expect(overAttemptCap(claim!)).toBe(false);
    }

    expect(await store.getSession('parked-session')).toMatchObject({
      status: 'running',
      attempt: 1,
    });
  });

  it('caps six unclean-death takeovers with a cap of five', async () => {
    await store.createSession({
      id: 'crashloop-session',
      ownerId: 'owner',
      prompt: 'Keep crashing',
      stageId: 'stage',
    });

    let claim = await store.claimNextSession('worker-0', 100, {
      leaseTtlMs: 10_000,
      maxAttempts,
    });
    expect(claim).not.toBeNull();
    expect(overAttemptCap(claim!)).toBe(false);

    for (let cycle = 0; cycle < 6; cycle += 1) {
      await pool.query(
        `UPDATE agent_sessions SET lease_heartbeat_at = 0
         WHERE id = 'crashloop-session'`,
      );
      claim = await store.claimNextSession(`worker-${cycle + 1}`, 101 + cycle, {
        leaseTtlMs: 10_000,
        maxAttempts,
      });
      expect(claim).toMatchObject({ attempt: cycle + 2, claimReason: 'orphaned' });
    }

    expect(overAttemptCap(claim!)).toBe(true);
    expect(await store.getSession('crashloop-session')).toMatchObject({
      status: 'running',
      attempt: 7,
    });
  });
});

describe.skipIf(!contractUrl)('late claims after pool shutdown (PostgreSQL)', () => {
  it.each(['committed', 'cancelled'] as const)(
    'cleans up a %s claim on the closing pool without spending another attempt',
    async (outcome) => {
      const schema = `late_claim_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: contractUrl });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const options = { connectionString: contractUrl, options: `-c search_path=${schema}` };
      const applicationName = `late-claim-${randomUUID()}`;
      runtime.pool = new Pool({ ...options, application_name: applicationName });
      const observer = new Pool(options);
      const blocker = await observer.connect();
      let runner: ReturnType<typeof startAgentRunner> | undefined;
      let closing: Promise<void> | undefined;
      const runtimeUrl = new URL(contractUrl!);
      runtimeUrl.searchParams.set('application_name', applicationName);
      vi.stubEnv('DATABASE_URL', runtimeUrl.toString());
      try {
        const store = await getAgentSessionStore();
        await store.createSession({ id: 'late-session', ownerId: 'owner', prompt: 'Wait' });
        await blocker.query('BEGIN');
        await blocker.query("SELECT id FROM agent_sessions WHERE id = 'late-session' FOR UPDATE");
        runner = startAgentRunner();
        // Observe the real blocked claim, rather than assuming a timer started it.
        await expect
          .poll(
            async () => {
              const result = await admin.query(
                `SELECT 1 FROM pg_stat_activity
           WHERE application_name = $1 AND wait_event_type = 'Lock'
             AND query LIKE '%FOR UPDATE%'`,
                [applicationName],
              );
              return result.rowCount;
            },
            { timeout: 5_000 },
          )
          .toBe(1);
        // Zero exercises the existing deadline-expired branch without a 15s sleep.
        await runner.stop({ timeoutMs: 0 });
        closing = runtime.pool.end();
        if (outcome === 'cancelled') {
          await admin.query(
            `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
           WHERE application_name = $1 AND wait_event_type = 'Lock'`,
            [applicationName],
          );
        }
        await blocker.query('COMMIT');
        await closing;
        const settled = await observer.query(
          "SELECT status, attempt, lease_worker_id FROM agent_sessions WHERE id = 'late-session'",
        );
        expect(settled.rows[0]).toEqual({
          status: outcome === 'committed' ? 'running' : 'queued',
          attempt: outcome === 'committed' ? 1 : 0,
          lease_worker_id: null,
        });
        expect(runtime.buildAgent).not.toHaveBeenCalled();
        const replacement = new PgAgentSessionStore(observer, {
          withTransaction: transactionFor(observer),
        });
        // Zero TTL also exposes an incorrectly retained lease immediately.
        expect(
          await replacement.claimNextSession('replacement', 200, {
            leaseTtlMs: 0,
            maxAttempts: 5,
          }),
        ).toMatchObject({
          attempt: 1,
          claimReason: outcome === 'committed' ? 'orphaned' : 'queued',
        });
      } finally {
        await runner?.stop({ timeoutMs: 0 });
        await blocker.query('ROLLBACK');
        blocker.release();
        await (closing ?? runtime.pool.end());
        await observer.end();
        try {
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        } finally {
          await admin.end();
          vi.unstubAllEnvs();
        }
      }
    },
    15_000,
  );
});
