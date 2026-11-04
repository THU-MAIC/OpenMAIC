/** Isolated local PG migration acceptance; no cloud resources. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { applySchemaMigrations } from '@openmaic/storage/pg-migrations';
import { SANDBOX_ENVIRONMENT_MIGRATIONS as migrations } from '@/lib/persistence/sandbox-environments';

it.skipIf(!process.env.PG_CONTRACT_URL)(
  'removes obsolete PG blobs without silently discarding development data',
  async () => {
    const schema = 'sandbox_migration_' + randomUUID().replaceAll('-', '');
    const admin = new Pool({ connectionString: process.env.PG_CONTRACT_URL });
    let pool: Pool | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: process.env.PG_CONTRACT_URL,
        options: `-c search_path=${schema}`,
      });
      await applySchemaMigrations(pool, {
        ...migrations,
        migrations: migrations.migrations.slice(0, 8),
      });
      await pool.query(
        "INSERT INTO sandbox_environments(id,owner_id,workspace_id,connection_fingerprint,state) VALUES('env','owner','workspace','connection','unknown')",
      );
      await pool.query(
        "INSERT INTO sandbox_workspace_checkpoints(owner_id,workspace_id,revision,source_environment_id,archive_hash,archive_bytes,archive_size) VALUES('owner','workspace',1,'env','hash',$1,4)",
        [Buffer.from('test')],
      );
      await expect(applySchemaMigrations(pool, migrations)).rejects.toThrow(
        'Remove obsolete development PG checkpoints',
      );
      expect(
        (
          await pool.query('SELECT archive_bytes FROM sandbox_workspace_checkpoints')
        ).rows[0].archive_bytes.toString(),
      ).toBe('test');
      await pool.query('DELETE FROM sandbox_workspace_checkpoints'); // Test-owned fixture only.
      await expect(applySchemaMigrations(pool, migrations)).resolves.toEqual([9, 10, 11]);
      expect(
        (
          await pool.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='sandbox_workspace_checkpoints' AND column_name='archive_bytes'",
            [schema],
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await pool.query(
            "SELECT is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='sandbox_workspace_checkpoints' AND column_name='object_id'",
            [schema],
          )
        ).rows[0].is_nullable,
      ).toBe('NO');
      expect(
        (await pool.query("SELECT workspace_ready FROM sandbox_environments WHERE id='env'"))
          .rows[0].workspace_ready,
      ).toBe(false);
      await expect(applySchemaMigrations(pool, migrations)).resolves.toEqual([]);
    } finally {
      await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
