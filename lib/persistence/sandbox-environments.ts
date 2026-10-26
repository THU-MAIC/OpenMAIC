import type { Queryable } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';

export const SANDBOX_ENVIRONMENT_MIGRATIONS: SchemaMigrationSet = {
  store: 'sandbox-environments',
  migrations: [
    {
      version: 1,
      name: 'baseline',
      transaction: false,
      up: `
CREATE TABLE IF NOT EXISTS sandbox_environments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_fingerprint TEXT NOT NULL,
  resource_id TEXT,
  state TEXT NOT NULL CHECK (state IN
    ('creating','unknown','running','paused','missing','destroying','destroyed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (state NOT IN ('running','paused','missing','destroying') OR resource_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS sandbox_environments_workspace_active_idx
  ON sandbox_environments(owner_id, workspace_id) WHERE state <> 'destroyed';
CREATE UNIQUE INDEX IF NOT EXISTS sandbox_environments_resource_idx
  ON sandbox_environments(connection_fingerprint, resource_id) WHERE resource_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sandbox_environments_owner_idx
  ON sandbox_environments(owner_id, created_at DESC);
`,
    },
    {
      version: 2,
      name: 'commands',
      transaction: true,
      up: `
CREATE TABLE IF NOT EXISTS sandbox_commands (
  environment_id TEXT NOT NULL REFERENCES sandbox_environments(id),
  id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  result_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (environment_id, id)
);
`,
    },
    {
      version: 3,
      name: 'runtime-profiles',
      transaction: true,
      up: `ALTER TABLE sandbox_environments ADD COLUMN profile TEXT NOT NULL DEFAULT 'code'
        CHECK (profile IN ('code','desktop'));`,
    },
    {
      version: 4,
      name: 'terminals',
      transaction: true,
      up: `CREATE TABLE sandbox_terminals (
        environment_id TEXT NOT NULL REFERENCES sandbox_environments(id),
        id TEXT NOT NULL,
        pid INTEGER,
        state TEXT NOT NULL CHECK(state IN ('creating','unknown','running','closed')),
        PRIMARY KEY(environment_id,id)
      );
      CREATE UNIQUE INDEX sandbox_terminal_active_idx ON sandbox_terminals(environment_id) WHERE state <> 'closed';`,
    },
    {
      version: 5,
      name: 'workspace-checkpoints',
      transaction: true,
      up: `CREATE TABLE sandbox_workspace_checkpoints (
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        source_environment_id TEXT NOT NULL REFERENCES sandbox_environments(id),
        archive_hash TEXT NOT NULL,
        archive_bytes BYTEA NOT NULL CHECK (octet_length(archive_bytes) <= 25165824),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, workspace_id)
      );
      ALTER TABLE sandbox_environments ADD COLUMN restore_hash TEXT;
      ALTER TABLE sandbox_environments ADD COLUMN workspace_ready BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE sandbox_environments ADD COLUMN preview_epoch INTEGER NOT NULL DEFAULT 0;`,
    },
    {
      version: 6,
      name: 'session-tool-grants',
      transaction: true,
      up: `CREATE TABLE sandbox_session_grants (
        session_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        environment_id TEXT NOT NULL REFERENCES sandbox_environments(id),
        grant_id TEXT NOT NULL,
        allow_writes BOOLEAN NOT NULL,
        allow_commands BOOLEAN NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );`,
    },
    {
      version: 7,
      name: 'external-checkpoint-bytes',
      transaction: true,
      up: `CREATE TABLE sandbox_checkpoint_objects (
        id TEXT PRIMARY KEY,
        source_environment_id TEXT NOT NULL REFERENCES sandbox_environments(id),
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        object_prefix TEXT NOT NULL,
        policy_json JSONB NOT NULL,
        parts_json JSONB NOT NULL DEFAULT '[]',
        archive_size BIGINT NOT NULL DEFAULT 0 CHECK(archive_size>=0),
        state TEXT NOT NULL CHECK(state IN ('pending','committed','retired')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX sandbox_checkpoint_objects_gc_idx ON sandbox_checkpoint_objects(state,updated_at);
      CREATE INDEX sandbox_checkpoint_objects_owner_idx ON sandbox_checkpoint_objects(owner_id);
      ALTER TABLE sandbox_workspace_checkpoints ALTER COLUMN archive_bytes DROP NOT NULL;
      ALTER TABLE sandbox_workspace_checkpoints ADD COLUMN object_id TEXT REFERENCES sandbox_checkpoint_objects(id);
      ALTER TABLE sandbox_workspace_checkpoints ADD COLUMN archive_size BIGINT;
      UPDATE sandbox_workspace_checkpoints SET archive_size=octet_length(archive_bytes);
      ALTER TABLE sandbox_workspace_checkpoints ALTER COLUMN archive_size SET NOT NULL;
      ALTER TABLE sandbox_workspace_checkpoints ADD CHECK (
        (archive_bytes IS NOT NULL AND object_id IS NULL) OR
        (archive_bytes IS NULL AND object_id IS NOT NULL));`,
    },
    {
      version: 8,
      name: 'installation-settings',
      transaction: true,
      up: `CREATE TABLE sandbox_settings (
        id INTEGER PRIMARY KEY CHECK (id=1),
        config JSONB NOT NULL,
        secret JSONB,
        revision INTEGER NOT NULL CHECK (revision>0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );`,
    },
    {
      version: 9,
      name: 'remove-development-checkpoint-blobs',
      transaction: true,
      up: async (db) => {
        // Never silently discard development-only data in an older local checkout.
        const legacy = await db.query(
          'SELECT 1 FROM sandbox_workspace_checkpoints WHERE object_id IS NULL LIMIT 1',
        );
        if (legacy.rows.length)
          throw new Error(
            'Remove obsolete development PG checkpoints before upgrading. No legacy restore path is supported.',
          );
        await db.query('ALTER TABLE sandbox_workspace_checkpoints DROP COLUMN archive_bytes');
        await db.query(
          'ALTER TABLE sandbox_workspace_checkpoints ALTER COLUMN object_id SET NOT NULL',
        );
        await db.query(
          'ALTER TABLE sandbox_environments ALTER COLUMN workspace_ready SET DEFAULT false',
        );
        await db.query(
          "UPDATE sandbox_environments SET workspace_ready=false WHERE state IN ('creating','unknown') AND resource_id IS NULL",
        );
      },
    },
    {
      version: 10,
      name: 'maintenance-fairness',
      transaction: true,
      up: `ALTER TABLE sandbox_environments ADD COLUMN maintenance_checked_at TIMESTAMPTZ;
      CREATE INDEX sandbox_environments_maintenance_idx ON sandbox_environments(maintenance_checked_at,id)
        WHERE state<>'destroyed';`,
    },
  ],
};

export async function ensureSandboxEnvironmentSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, SANDBOX_ENVIRONMENT_MIGRATIONS);
}
