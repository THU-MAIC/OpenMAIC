/** Local PG only. No cloud resources. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { SandboxStore } from '@/lib/server/sandbox/store';

describe.skipIf(!process.env.PG_CONTRACT_URL)('sandbox lock admission', () => {
  it('leaves a SQL connection available and releases admission after failure', async () => {
    const pool = new Pool({
      connectionString: process.env.PG_CONTRACT_URL,
      max: 2,
      connectionTimeoutMillis: 500,
    });
    const store = Reflect.construct(SandboxStore, [{ pool }]) as SandboxStore;
    // Separate store instances share one upstream pool and must share the admission bound.
    const other = Reflect.construct(SandboxStore, [{ pool }]) as SandboxStore;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.exclusive(randomUUID(), async () => {
      entered();
      await gate;
      throw new Error('operation failed');
    });
    const firstResult = first.catch((error: Error) => error.message);
    try {
      await ready;
      await expect(
        other.exclusive(randomUUID(), async () => {
          await pool.query('SELECT 1');
        }),
      ).rejects.toMatchObject({ code: 'SANDBOX_BUSY', status: 429 });
      expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    } finally {
      release();
      expect(await firstResult).toBe('operation failed');
      await expect(
        store.exclusive(randomUUID(), async () => (await pool.query('SELECT 2 AS ok')).rows[0].ok),
      ).resolves.toBe(2);
      await pool.end();
    }
  });
});
