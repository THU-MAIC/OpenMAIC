/** Isolated schema on local PG; no cloud requests or real credentials. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nodePostgresTransaction } from '@openmaic/storage/server/reference';
vi.mock('server-only', () => ({}));
let pool: Pool;
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    pool,
    withTransaction: nodePostgresTransaction(pool),
  }),
}));
vi.mock('@/lib/server/sandbox/checkpoint-storage', () => ({
  CheckpointStorage: class {
    async available() {
      return true;
    }
  },
}));
import {
  saveSandboxSettings,
  resolvedSandboxConfig,
  sandboxSettingsView,
} from '@/lib/server/sandbox/settings';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import { SandboxStore } from '@/lib/server/sandbox/store';
import { ensureOwnerMergeSchema } from '@/lib/persistence/owner-merges';
const schema = 'sandbox_settings_' + randomUUID().replaceAll('-', '');
const fields = {
  enabled: true,
  provider: 'e2b-compatible',
  connectionId: 'pg-test',
  apiUrl: 'https://api.e2b.dev',
  domain: 'e2b.app',
  template: 'code',
  desktopTemplate: '',
  lifetimeMs: 300000,
  maxActive: 5,
  maxActivePerOwner: 1,
};
describe.skipIf(!process.env.PG_CONTRACT_URL)('sandbox settings PG transaction boundary', () => {
  beforeAll(async () => {
    const admin = new Pool({ connectionString: process.env.PG_CONTRACT_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    pool = new Pool({
      connectionString: process.env.PG_CONTRACT_URL,
      options: `-c search_path=${schema}`,
    });
    vi.stubEnv('DATABASE_URL', 'fixture');
    setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
    vi.stubEnv('OPENMAIC_SECRET_KEY', 'pg-test-secret-only');
    await ensureOwnerMergeSchema(pool);
  });
  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
    setDeploymentConfigForTests();
    vi.unstubAllEnvs();
  });
  it('persists encrypted key, rejects stale creation, fences changes against outstanding reservations', async () => {
    const view = await saveSandboxSettings({ revision: 0, fields, apiKey: 'pg-key-only' });
    expect(view.revision).toBe(1);
    const stored = (await pool.query('SELECT * FROM sandbox_settings')).rows[0];
    expect(JSON.stringify(stored)).not.toContain('pg-key-only');
    expect((await resolvedSandboxConfig()).apiKey).toBe('pg-key-only');
    const store = await SandboxStore.open();
    const reservation = {
      ownerId: 'test-owner',
      id: randomUUID(),
      workspaceId: 'test',
      profile: 'code' as const,
      fingerprint: (await resolvedSandboxConfig()).fingerprint,
      maxActive: 1,
      maxActiveTotal: 5,
      settingsRevision: 0,
    };
    await expect(store.reserve(reservation)).rejects.toMatchObject({ status: 409 });
    await store.reserve({ ...reservation, settingsRevision: 1 });
    await expect(
      saveSandboxSettings({ revision: 1, fields: { ...fields, enabled: false } }),
    ).rejects.toMatchObject({ status: 409 });
    await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
      reservation.id,
    ]);
    const writes = await Promise.allSettled([
      saveSandboxSettings({ revision: 1, fields: { ...fields, lifetimeMs: 600000 } }),
      saveSandboxSettings({ revision: 1, fields: { ...fields, lifetimeMs: 900000 } }),
    ]);
    expect(writes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect((await sandboxSettingsView()).revision).toBe(2);
  });
  it('serializes a configuration change with a simultaneous creation', async () => {
    const store = await SandboxStore.open(),
      config = await resolvedSandboxConfig();
    const result = await Promise.allSettled([
      saveSandboxSettings({ revision: 2, fields: { ...fields, lifetimeMs: 120000 } }),
      store.reserve({
        ownerId: 'test-race',
        id: randomUUID(),
        workspaceId: 'race',
        profile: 'code',
        fingerprint: config.fingerprint,
        maxActive: 1,
        maxActiveTotal: 5,
        settingsRevision: 2,
      }),
    ]);
    expect(result.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((x) => x.status === 'rejected')).toHaveLength(1);
  });
});
