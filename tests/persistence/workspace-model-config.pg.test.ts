import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import {
  ensureWorkspaceModelConfigSchema,
  readWorkspaceModelConfig,
  saveWorkspaceModelConfig,
  WorkspaceConfigConflictError,
} from '@/lib/persistence/workspace-model-config';
import { storedSecretKids } from '@/lib/server/instance-secret-check';
import { instanceKey, resetInstanceKeyForTests } from '@/lib/server/secret-box';

const contractUrl = process.env.PG_CONTRACT_URL;

describe.skipIf(!contractUrl)('workspace model configuration on PostgreSQL', () => {
  let pool: Pool;
  const queryable = () => pool as unknown as ConnectableQueryable;

  beforeAll(async () => {
    vi.stubEnv('OPENMAIC_SECRET_KEY', 'pg-contract-secret');
    resetInstanceKeyForTests();
    pool = new Pool({ connectionString: contractUrl });
    await ensureWorkspaceModelConfigSchema(queryable());
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE workspace_model_config');
  });

  afterAll(async () => {
    await pool.end();
    vi.unstubAllEnvs();
    resetInstanceKeyForTests();
  });

  /**
   * The pool, with every insert into the table held until `parties` of them
   * arrived: both first saves are then past their read of the missing row.
   */
  function insertBarrier(parties: number): ConnectableQueryable {
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    return {
      query: (text: string, params?: unknown[]) => pool.query(text, params),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (text: string, params?: unknown[]) => {
            if (/^\s*INSERT INTO workspace_model_config/.test(text)) {
              arrived += 1;
              if (arrived === parties) open();
              await gate;
            }
            return client.query(text, params);
          },
          release: () => client.release(),
        };
      },
    } as unknown as ConnectableQueryable;
  }

  /** Wait until `count` backends are blocked by the backend `pid`, directly or in its queue. */
  async function waitForBlockedBy(pid: number, count: number): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      // Directly, or behind a backend that is: PostgreSQL queues a second
      // waiter for a row lock behind the first.
      const blocked = await pool.query<{ n: number }>(
        `WITH direct AS (
           SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
         )
         SELECT (SELECT count(*) FROM direct)::int + (
           SELECT count(*) FROM pg_stat_activity AS a
            WHERE a.pid NOT IN (SELECT pid FROM direct)
              AND pg_blocking_pids(a.pid) && ARRAY(SELECT pid FROM direct)
         )::int AS n`,
        [pid],
      );
      if (blocked.rows[0]!.n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the saves never queued behind the row lock');
  }

  const config = (model: string) => ({
    providers: { ds: { preset: 'deepseek', apiKey: `sk-${model}` } },
    slots: { llm: `ds:${model}` },
  });

  async function expectOneWinner(
    results: PromiseSettledResult<number>[],
    revision: number,
  ): Promise<void> {
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      WorkspaceConfigConflictError,
    );
    const stored = await readWorkspaceModelConfig(queryable(), 'user:alice');
    expect(stored?.revision).toBe(revision);
    expect(stored?.config).toEqual(config(results[0]!.status === 'fulfilled' ? 'one' : 'two'));
  }

  it('lets exactly one of two concurrent first saves through', async () => {
    const barrier = insertBarrier(2);
    const results = await Promise.allSettled([
      saveWorkspaceModelConfig(barrier, 'user:alice', config('one'), null),
      saveWorkspaceModelConfig(barrier, 'user:alice', config('two'), null),
    ]);
    await expectOneWinner(results, 1);
  });

  it('lets exactly one of two concurrent saves from the same revision through', async () => {
    await saveWorkspaceModelConfig(queryable(), 'user:alice', config('base'), null);
    const holder = await pool.connect();
    let results: PromiseSettledResult<number>[];
    try {
      await holder.query('BEGIN');
      await holder.query(
        "SELECT 1 FROM workspace_model_config WHERE owner_id = 'user:alice' FOR UPDATE",
      );
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      const pending = Promise.allSettled([
        saveWorkspaceModelConfig(queryable(), 'user:alice', config('one'), 1),
        saveWorkspaceModelConfig(queryable(), 'user:alice', config('two'), 1),
      ]);
      await waitForBlockedBy(pid, 2);
      await holder.query('COMMIT');
      results = await pending;
    } finally {
      holder.release();
    }
    await expectOneWinner(results, 2);
  });

  it('counts the stored keys by the instance secret that sealed them', async () => {
    const keyed = (id: string) => ({ providers: { [id]: { preset: 'deepseek', apiKey: 'sk' } } });
    const first = instanceKey().kid;
    await saveWorkspaceModelConfig(queryable(), 'user:alice', keyed('a'), null);
    await saveWorkspaceModelConfig(queryable(), 'user:bob', keyed('b'), null);
    await saveWorkspaceModelConfig(queryable(), 'user:carol', { slots: { llm: null } }, null);
    vi.stubEnv('OPENMAIC_SECRET_KEY', 'pg-contract-secret-rotated');
    resetInstanceKeyForTests();
    try {
      const second = instanceKey().kid;
      await saveWorkspaceModelConfig(queryable(), 'user:dave', keyed('d'), null);
      expect(await storedSecretKids(queryable())).toEqual({ [first]: 2, [second]: 1 });
    } finally {
      vi.stubEnv('OPENMAIC_SECRET_KEY', 'pg-contract-secret');
      resetInstanceKeyForTests();
    }
  });
});
