import 'server-only';
import { assertSandboxSettingsRevision } from './settings';
import type { Pool, PoolClient } from 'pg';
import type { Queryable } from '@openmaic/storage/document/pg';
import { CheckpointStorage, type SavedCheckpoint } from './checkpoint-storage';

import { fenceOwnerWrite } from '@/lib/persistence/owner-merges';
import { ensureSandboxEnvironmentSchema } from '@/lib/persistence/sandbox-environments';
import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';
import {
  getServerPersistenceProvider,
  type ServerPersistenceProvider,
} from '@/lib/persistence/server-provider';
import { SandboxError, sandboxConflict, sandboxNotFound } from '@/lib/sandbox/errors';
import type {
  SandboxCommandResult,
  SandboxEnvironment,
  SandboxState,
  SandboxProfile,
} from '@/lib/sandbox/types';

export interface SandboxRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  workspace_id: string;
  profile: SandboxProfile;
  connection_fingerprint: string;
  resource_id: string | null;
  state: SandboxState;
  restore_hash: string | null;
  workspace_ready: boolean;
  preview_epoch: number;
  created_at: Date;
  updated_at: Date;
}

export interface TerminalRow extends Record<string, unknown> {
  id: string;
  pid: number | null;
  state: 'creating' | 'unknown' | 'running' | 'closed';
}

export function publicEnvironment(row: SandboxRow): SandboxEnvironment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    profile: row.profile,
    state: row.state,
    workspaceReady: row.workspace_ready,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// Session locks hold a connection across cloud I/O; their actions also need SQL connections.
// Share admission across store instances using the same upstream pool, leaving half for SQL.
const activeLocks = new WeakMap<Pool, number>();

export class SandboxStore {
  private constructor(private readonly persistence: ServerPersistenceProvider) {}

  static async open(): Promise<SandboxStore> {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new SandboxError(
        'SANDBOX_STORAGE_UNAVAILABLE',
        503,
        'Sandbox storage is not configured.',
      );
    }
    const persistence = await getServerPersistenceProvider(databaseUrl);
    // Lazy like the other optional stores; disabling the feature provisions no table.
    await withSchemaBootstrapLock(persistence.pool, ensureSandboxEnvironmentSchema);
    return new SandboxStore(persistence);
  }

  async get(ownerId: string, id: string): Promise<SandboxRow> {
    const result = await this.persistence.pool.query<SandboxRow>(
      'SELECT * FROM sandbox_environments WHERE owner_id = $1 AND id = $2',
      [ownerId, id],
    );
    if (!result.rows[0]) throw sandboxNotFound();
    return result.rows[0];
  }

  /** Background maintenance may only manage the environment still bound to an owned study. */
  async assertLearningBinding(studyId: string, ownerId: string, id: string) {
    const result = await this.persistence.pool.query(
      `SELECT 1 FROM pbl_v3_studies s JOIN sandbox_environments e
         ON (e.id=s.environment_id OR e.id=s.environment_recovery->>'requestId')
       WHERE s.id=$1 AND s.owner_id=$2 AND e.id=$3 AND e.owner_id=$2
         AND e.workspace_id=$4`,
      [studyId, ownerId, id, `pbl-${studyId}`],
    );
    if (!result.rows.length) throw sandboxNotFound();
  }

  async list(ownerId: string): Promise<SandboxRow[]> {
    const result = await this.persistence.pool.query<SandboxRow>(
      `SELECT * FROM sandbox_environments WHERE owner_id = $1
       AND state <> 'destroyed' ORDER BY created_at DESC`,
      [ownerId],
    );
    return result.rows;
  }

  /** Serialize admission with Stop's epoch update, without holding a transaction over provider I/O. */
  private async assertWorkspaceEpoch(tx: Queryable, row: SandboxRow, epoch?: number) {
    if (epoch === undefined) return;
    const current = await tx.query<{ preview_epoch: number }>(
      'SELECT preview_epoch FROM sandbox_environments WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [row.owner_id, row.id],
    );
    if (current.rows[0]?.preview_epoch !== epoch)
      throw sandboxConflict('Workspace was stopped. Retry the operation.', 'WORKSPACE_STOPPED');
  }

  async reserveCommand(
    row: SandboxRow,
    id: string,
    fingerprint: string,
    epoch?: number,
  ): Promise<boolean> {
    return this.persistence.withTransaction(async (tx) => {
      await fenceOwnerWrite(tx, row.owner_id);
      await this.assertWorkspaceEpoch(tx, row, epoch);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `sandbox.command:${row.id}`,
      ]);
      const existing = await tx.query<{ request_fingerprint: string }>(
        'SELECT request_fingerprint FROM sandbox_commands WHERE environment_id = $1 AND id = $2',
        [row.id, id],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_fingerprint !== fingerprint)
          throw sandboxConflict('This command request ID was already used with different input.');
        return false;
      }
      const active = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM sandbox_commands WHERE environment_id = $1
         AND (result_json IS NULL OR result_json->>'state' IN ('starting','running','unknown'))`,
        [row.id],
      );
      if (Number(active.rows[0].count) >= 16)
        throw new SandboxError(
          'SANDBOX_LIMIT',
          429,
          'Reconcile or cancel active commands before starting more.',
        );
      await tx.query(
        'INSERT INTO sandbox_commands(environment_id,id,request_fingerprint) VALUES ($1,$2,$3)',
        [row.id, id, fingerprint],
      );
      return true;
    });
  }

  async command(row: SandboxRow, id: string): Promise<SandboxCommandResult | null> {
    const found = await this.persistence.pool.query<{ result_json: SandboxCommandResult | null }>(
      'SELECT result_json FROM sandbox_commands WHERE environment_id=$1 AND id=$2',
      [row.id, id],
    );
    if (!found.rows[0]) throw sandboxNotFound();
    return found.rows[0].result_json;
  }

  async listCommands(row: SandboxRow) {
    const result = await this.persistence.pool.query<{
      id: string;
      state: string;
      exitCode: number | null;
    }>(
      `SELECT id,COALESCE(result_json->>'state','unknown') AS state,
         (result_json->>'exitCode')::integer AS "exitCode"
       FROM sandbox_commands WHERE environment_id=$1
       ORDER BY (result_json IS NULL OR result_json->>'state' IN ('starting','running','unknown')) DESC,
         created_at DESC LIMIT 100`,
      [row.id],
    );
    return result.rows;
  }

  async listTerminals(row: SandboxRow) {
    const result = await this.persistence.pool.query<Pick<TerminalRow, 'id' | 'state'>>(
      `SELECT id,state FROM sandbox_terminals WHERE environment_id=$1
       ORDER BY (state<>'closed') DESC,id LIMIT 100`,
      [row.id],
    );
    return result.rows;
  }

  async saveCommand(row: SandboxRow, result: SandboxCommandResult): Promise<void> {
    await this.persistence.withTransaction(async (tx) => {
      await fenceOwnerWrite(tx, row.owner_id);
      // A late read must never overwrite an already-observed terminal result.
      await tx.query(
        `UPDATE sandbox_commands SET result_json=$3::jsonb,updated_at=now()
        WHERE environment_id=$1 AND id=$2 AND
        (result_json IS NULL OR result_json->>'state' IN ('starting','running','unknown'))`,
        [row.id, result.id, JSON.stringify(result)],
      );
    });
  }

  async reserveTerminal(row: SandboxRow, id: string, epoch?: number) {
    return this.persistence.withTransaction(async (tx) => {
      await fenceOwnerWrite(tx, row.owner_id);
      await this.assertWorkspaceEpoch(tx, row, epoch);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `sandbox.terminal:${row.id}`,
      ]);
      const old = await tx.query<TerminalRow>(
        'SELECT id,pid,state FROM sandbox_terminals WHERE environment_id=$1 AND id=$2',
        [row.id, id],
      );
      if (old.rows[0]) return { row: old.rows[0], created: false };
      const active = await tx.query(
        "SELECT id FROM sandbox_terminals WHERE environment_id=$1 AND state<>'closed'",
        [row.id],
      );
      if (active.rows.length)
        throw sandboxConflict('This environment already has an active or unresolved terminal.');
      const inserted = await tx.query<TerminalRow>(
        `INSERT INTO sandbox_terminals(environment_id,id,state)
        VALUES($1,$2,'creating') RETURNING id,pid,state`,
        [row.id, id],
      );
      return { row: inserted.rows[0], created: true };
    });
  }

  async terminal(row: SandboxRow, id: string): Promise<TerminalRow> {
    const found = await this.persistence.pool.query<TerminalRow>(
      'SELECT id,pid,state FROM sandbox_terminals WHERE environment_id=$1 AND id=$2',
      [row.id, id],
    );
    if (!found.rows[0]) throw sandboxNotFound();
    return found.rows[0];
  }

  async setTerminal(row: SandboxRow, id: string, state: TerminalRow['state'], pid: number | null) {
    await this.persistence.withTransaction(async (tx) => {
      await fenceOwnerWrite(tx, row.owner_id);
      await tx.query(
        `UPDATE sandbox_terminals SET state=$3,pid=COALESCE($4,pid)
        WHERE environment_id=$1 AND id=$2 AND state<>'closed'`,
        [row.id, id, state, pid],
      );
    });
    return this.terminal(row, id);
  }

  async reconciliationCandidates(fingerprint: string): Promise<SandboxRow[]> {
    return (
      await this.persistence.pool.query<SandboxRow>(
        `SELECT * FROM sandbox_environments WHERE connection_fingerprint=$1
       AND resource_id IS NOT NULL AND state IN ('running','paused','missing','destroying')
       ORDER BY updated_at LIMIT 5`,
        [fingerprint],
      )
    ).rows;
  }

  /** Reserve before contacting the provider. No network I/O holds the database lock. */
  async reserve(input: {
    ownerId: string;
    id: string;
    workspaceId: string;
    fingerprint: string;
    maxActive: number;
    maxActiveTotal: number;
    settingsRevision?: number;
    profile: SandboxProfile;
  }): Promise<{ row: SandboxRow; created: boolean }> {
    return this.persistence.withTransaction(async (tx) => {
      // Shared across owners in this installation; unknown allocations count too.
      // Separate installations and direct SDK calls still need a provider Team budget.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('openmaic.sandbox.capacity', 0))",
      );
      await assertSandboxSettingsRevision(tx, input.settingsRevision ?? 0);
      await fenceOwnerWrite(tx, input.ownerId);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `openmaic.sandbox.owner:${input.ownerId}`,
      ]);
      const existing = await tx.query<SandboxRow>(
        'SELECT * FROM sandbox_environments WHERE id = $1',
        [input.id],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.owner_id !== input.ownerId) throw sandboxNotFound();
        if (row.workspace_id !== input.workspaceId || row.profile !== input.profile) {
          throw sandboxConflict('This request ID was already used for another workspace.');
        }
        return { row, created: false };
      }
      const active = await tx.query<SandboxRow>(
        "SELECT * FROM sandbox_environments WHERE owner_id = $1 AND state <> 'destroyed'",
        [input.ownerId],
      );
      if (active.rows.some((row) => row.workspace_id === input.workspaceId)) {
        throw sandboxConflict(
          'This workspace already has an environment. Retrieve or reconcile it.',
        );
      }
      if (active.rows.length >= input.maxActive) {
        throw new SandboxError('SANDBOX_LIMIT', 429, 'The active sandbox limit has been reached.');
      }
      const total = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM sandbox_environments WHERE state <> 'destroyed'",
      );
      if (Number(total.rows[0].count) >= input.maxActiveTotal) {
        throw new SandboxError(
          'SANDBOX_LIMIT',
          429,
          'The installation sandbox limit has been reached.',
        );
      }
      const inserted = await tx.query<SandboxRow>(
        `INSERT INTO sandbox_environments
         (id, owner_id, workspace_id, connection_fingerprint, profile, state, workspace_ready)
         VALUES ($1, $2, $3, $4, $5, 'creating', false) RETURNING *`,
        [input.id, input.ownerId, input.workspaceId, input.fingerprint, input.profile],
      );
      return { row: inserted.rows[0], created: true };
    });
  }

  /** Stale responses cannot resurrect a resource that another request is destroying. */
  async transition(
    row: SandboxRow,
    from: readonly SandboxState[],
    state: SandboxState,
    resourceId: string | null = row.resource_id,
  ): Promise<SandboxRow> {
    await this.persistence.withTransaction(async (tx) => {
      await fenceOwnerWrite(tx, row.owner_id);
      await tx.query(
        `UPDATE sandbox_environments SET state = $3, resource_id = $4, updated_at = now()
         WHERE owner_id = $1 AND id = $2 AND state = ANY($5::text[])
           AND (resource_id IS NULL OR resource_id = $4)`,
        [row.owner_id, row.id, state, resourceId, [...from]],
      );
    });
    return this.get(row.owner_id, row.id);
  }
  /** Session advisory lock: bounded operations, no open SQL transaction during cloud I/O. */
  async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const pool = this.persistence.pool;
    const active = activeLocks.get(pool) ?? 0;
    if (active >= Math.floor((pool.options.max ?? 10) / 2)) {
      throw new SandboxError('SANDBOX_BUSY', 429, 'Sandbox operations are busy. Retry shortly.');
    }
    activeLocks.set(pool, active + 1);
    let client: PoolClient | undefined;
    const key = `sandbox.environment:${id}`;
    let locked = false;
    let releaseError: Error | undefined;
    try {
      client = await pool.connect();
      locked = (
        await client.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',
          [key],
        )
      ).rows[0].ok;
      if (!locked)
        throw sandboxConflict(
          'Another operation is changing this environment. Retry after it finishes.',
          'ENVIRONMENT_BUSY',
        );
      return await action();
    } finally {
      if (locked && client)
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
        } catch {
          releaseError = new Error('Sandbox lock connection failed');
        }
      activeLocks.set(pool, (activeLocks.get(pool) ?? 1) - 1);
      client?.release(releaseError);
    }
  }

  async checkpointSummaries(ownerId: string) {
    const result = await this.persistence.pool.query<{
      workspaceId: string;
      revision: number;
      bytes: number;
      createdAt: Date;
    }>(
      `SELECT workspace_id AS "workspaceId",revision,archive_size::float8 AS bytes,
        created_at AS "createdAt" FROM sandbox_workspace_checkpoints WHERE owner_id=$1
        ORDER BY created_at DESC LIMIT 200`,
      [ownerId],
    );
    return result.rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  async deleteCheckpoint(ownerId: string, workspaceId: string, revision: number) {
    await this.persistence.withTransaction(async (tx) => {
      // Same order as allocation, preventing deletion between reserve and restore.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('openmaic.sandbox.capacity',0))",
      );
      await fenceOwnerWrite(tx, ownerId);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `sandbox.checkpoint:${ownerId}`,
      ]);
      const active = await tx.query(
        "SELECT id FROM sandbox_environments WHERE owner_id=$1 AND workspace_id=$2 AND state<>'destroyed' LIMIT 1",
        [ownerId, workspaceId],
      );
      if (active.rows.length)
        throw sandboxConflict('Release the environment before deleting its saved project.');
      const removed = await tx.query(
        'DELETE FROM sandbox_workspace_checkpoints WHERE owner_id=$1 AND workspace_id=$2 AND revision=$3 RETURNING object_id',
        [ownerId, workspaceId, revision],
      );
      if (removed.rows[0]?.object_id)
        await tx.query(
          "UPDATE sandbox_checkpoint_objects SET state='retired',updated_at=now() WHERE id=$1",
          [removed.rows[0].object_id],
        );
      if (!removed.rows.length)
        throw sandboxConflict(
          'Checkpoint changed or was already deleted. Refresh before deleting.',
        );
    });
  }

  private checkpointStorage() {
    return new CheckpointStorage(this.persistence, (key, action) => this.exclusive(key, action));
  }

  checkpointStorageAvailable() {
    return this.checkpointStorage().available();
  }
  checkpoint(ownerId: string, workspaceId: string) {
    return this.checkpointStorage().get(ownerId, workspaceId);
  }
  saveCheckpoint(
    row: SandboxRow,
    expectedRevision: number,
    source: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ) {
    return this.checkpointStorage().saveLocked(row, expectedRevision, source, signal);
  }
  async assertCheckpointReadable(ownerId: string, saved: SavedCheckpoint) {
    // Check configuration, path policy and a real object read before allocating cloud compute.
    // Full archive integrity is checked again during restoration.
    for await (const chunk of this.readCheckpoint(ownerId, saved)) {
      if (chunk.byteLength) return;
    }
    throw sandboxConflict('Checkpoint archive is empty.');
  }
  readCheckpoint(ownerId: string, saved: SavedCheckpoint) {
    return this.checkpointStorage().read(ownerId, saved);
  }
  collectCheckpoints() {
    return this.checkpointStorage().collect();
  }

  async restoreState(row: SandboxRow, hash: string | null, ready: boolean) {
    await this.persistence.withTransaction(async (tx) => {
      await fenceOwnerWrite(tx, row.owner_id);
      const updated = await tx.query(
        `UPDATE sandbox_environments SET restore_hash=$3,workspace_ready=$4,updated_at=now()
        WHERE owner_id=$1 AND id=$2 AND state='running' AND (restore_hash IS NULL OR restore_hash=$3) RETURNING id`,
        [row.owner_id, row.id, hash, ready],
      );
      if (!updated.rows.length) throw sandboxConflict('Environment changed during restoration.');
    });
  }

  async revokePreviews(row: SandboxRow) {
    await this.persistence.withTransaction(async (tx) => {
      await fenceOwnerWrite(tx, row.owner_id);
      await tx.query(
        'UPDATE sandbox_environments SET preview_epoch=preview_epoch+1 WHERE owner_id=$1 AND id=$2',
        [row.owner_id, row.id],
      );
    });
  }

  async sessionGrant(sessionId: string, ownerId: string) {
    const result = await this.persistence.pool.query<{
      session_id: string;
      environment_id: string;
      grant_id: string;
      allow_writes: boolean;
      allow_commands: boolean;
    }>(
      `SELECT session_id,environment_id,grant_id,allow_writes,allow_commands
        FROM sandbox_session_grants WHERE session_id=$1 AND owner_id=$2 AND expires_at>now()`,
      [sessionId, ownerId],
    );
    return result.rows[0] ?? null;
  }

  async grantSession(
    row: SandboxRow,
    sessionId: string,
    grantId: string,
    writes: boolean,
    commands: boolean,
  ) {
    await this.persistence.withTransaction(async (tx) => {
      await fenceOwnerWrite(tx, row.owner_id);
      await writeSessionGrant(tx, row, sessionId, grantId, writes, commands);
    });
  }

  async revokeSession(ownerId: string, sessionId: string) {
    await this.persistence.withTransaction(async (tx) => {
      await fenceOwnerWrite(tx, ownerId);
      await tx.query('DELETE FROM sandbox_session_grants WHERE session_id=$1 AND owner_id=$2', [
        sessionId,
        ownerId,
      ]);
    });
  }
}

/** Internal grant writer for hosts that atomically create a real Agent session and its binding. */
export async function writeSessionGrant(
  tx: import('@openmaic/storage/document/pg').Queryable,
  row: { owner_id: string; id: string },
  sessionId: string,
  grantId: string,
  writes: boolean,
  commands: boolean,
) {
  await tx.query(
    `INSERT INTO sandbox_session_grants
        (session_id,owner_id,environment_id,grant_id,allow_writes,allow_commands,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 hour')
        ON CONFLICT(session_id) DO UPDATE SET environment_id=EXCLUDED.environment_id,
        grant_id=EXCLUDED.grant_id,allow_writes=EXCLUDED.allow_writes,
        allow_commands=EXCLUDED.allow_commands,expires_at=EXCLUDED.expires_at
        WHERE sandbox_session_grants.owner_id=EXCLUDED.owner_id`,
    [sessionId, row.owner_id, row.id, grantId, writes, commands],
  );
}
