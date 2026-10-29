import { describe, expect, it } from 'vitest';

import {
  PERSISTENCE_POOL_CONNECTION_TIMEOUT_MS,
  defaultPersistencePool,
} from '@/lib/persistence/server-provider';

describe('defaultPersistencePool', () => {
  it('bounds how long an acquire waits on an exhausted pool', async () => {
    const pool = defaultPersistencePool('postgres://user:pass@127.0.0.1:1/db');
    try {
      expect(pool.options.connectionTimeoutMillis).toBe(PERSISTENCE_POOL_CONNECTION_TIMEOUT_MS);
      expect(PERSISTENCE_POOL_CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });
});
