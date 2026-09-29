import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { ownerIdentityLockKey } from '@/lib/persistence/owner-merges';
import {
  ensureWorkspaceModelConfigSchema,
  readWorkspaceModelConfig,
  saveWorkspaceModelConfig,
  WorkspaceConfigConflictError,
} from '@/lib/persistence/workspace-model-config';
import { resetInstanceKeyForTests } from '@/lib/server/secret-box';

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

  async function waitForLockWaiters(count: number): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const waiting = await pool.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND datname = current_database()`,
      );
      if (waiting.rows.length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the saves never queued behind the identity lock');
  }

  const config = (model: string) => ({
    providers: { ds: { preset: 'deepseek', apiKey: `sk-${model}` } },
    slots: { llm: `ds:${model}` },
  });

  it.each([
    ['first saves', null],
    ['saves from the same revision', 1],
  ] as const)('lets exactly one of two concurrent %s through', async (_label, expected) => {
    if (expected !== null) {
      await saveWorkspaceModelConfig(queryable(), 'user:alice', config('base'), null);
    }
    // Hold the owner's identity lock exclusively, as a claim would, so both
    // saves queue behind it and then run side by side.
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      ownerIdentityLockKey('user:alice').toString(),
    ]);
    const pending = Promise.allSettled([
      saveWorkspaceModelConfig(queryable(), 'user:alice', config('one'), expected),
      saveWorkspaceModelConfig(queryable(), 'user:alice', config('two'), expected),
    ]);
    await waitForLockWaiters(2);
    await holder.query('COMMIT');
    holder.release();
    const results = await pending;
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      WorkspaceConfigConflictError,
    );
    const stored = await readWorkspaceModelConfig(queryable(), 'user:alice');
    expect(stored?.revision).toBe((expected ?? 0) + 1);
    const winner = results[0]!.status === 'fulfilled' ? 'one' : 'two';
    expect(stored?.config).toEqual(config(winner));
  });
});
