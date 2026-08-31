/**
 * PostgreSQL backend for durable session-scoped materials.
 *
 * The backend imports no database driver; a host supplies a direct queryable,
 * exactly like the runtime / agent-session / skill backends. The row's bytes
 * reside in the package's asset registry (hash-addressed byte store) and this
 * backend only persists the metadata row that records the returned asset ids.
 *
 * The DDL is pinned (see `pg-schema-contract.test.ts` in the package tests):
 * a deployment that provisions this table with its own migration tooling must
 * reproduce it exactly for `ensureAgentSessionMaterialSchema` to stay the
 * intended no-op. The `session_id` foreign key targets the agent-session
 * backend's `agent_sessions(id)` (default name) with ON DELETE CASCADE, so the
 * host must provision `ensureAgentSessionSchema` before this one — the same
 * dependency the URL trust-gate table has inside the agent-session schema.
 */
import type { Queryable, WithTransaction } from '../runtime/pg.js';
import { splitSqlStatements } from '../document/pg.js';
import {
  AGENT_SESSION_MATERIAL_KINDS,
  AgentSessionMaterialError,
  createMaterialId,
  createMaterialWriteClaimId,
  isAgentSessionMaterialKind,
  isMaterialExtractionErrorCode,
  type AgentSessionMaterial,
  type AgentSessionMaterialKind,
  type AgentSessionMaterialWriteClaim,
  type AgentSessionMaterialStore,
  type ClaimedMaterialExtraction,
  type ClaimMaterialExtractionOptions,
  type CompleteMaterialExtractionInput,
  type CreateAgentSessionMaterialInput,
  type CreateAgentSessionMaterialWriteClaimInput,
  type ListAgentSessionMaterialsOptions,
  MAX_MATERIAL_EXTRACTION_RETRIES,
  type MaterialExtractionFailureSettlement,
  type MaterialExtractionErrorCode,
  type MaterialExtractionState,
} from './types.js';

export type { QueryResult, Queryable } from '../runtime/pg.js';

export interface AgentSessionMaterialTableNames {
  materials: string;
  writeClaims: string;
}

export const DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES: Readonly<AgentSessionMaterialTableNames> =
  {
    materials: 'agent_session_materials',
    writeClaims: 'agent_session_material_write_claims',
  };

export interface PgAgentSessionMaterialStoreOptions {
  /** Required only by byte writes, which hold the session tombstone fence across object publish. */
  withTransaction?: WithTransaction;
  tableNames?: Partial<AgentSessionMaterialTableNames>;
  /** Test seams; production callers normally use the defaults. */
  createId?: () => string;
  createClaimId?: () => string;
  now?: () => Date;
}

/** Pinned default schema for the PostgreSQL agent-session-material backend. */
export const AGENT_SESSION_MATERIAL_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_session_materials (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT,
  source_url    TEXT,
  text_asset_id TEXT,
  raw_asset_id  TEXT,
  text_chars    INTEGER NOT NULL DEFAULT 0,
  derived_from  TEXT REFERENCES agent_session_materials(id) ON DELETE CASCADE,
  extraction_status TEXT NOT NULL DEFAULT 'done',
  extraction_attempts INTEGER NOT NULL DEFAULT 0,
  extraction_error TEXT,
  extraction_stats JSONB,
  extractor_version TEXT,
  extraction_lease_worker_id TEXT,
  extraction_lease_worker_pid INTEGER,
  extraction_lease_heartbeat_at BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_session_materials_kind_known CHECK (kind IN
    ('source','extraction','transcript','audio-track','image','web')),
  CONSTRAINT agent_session_materials_text_chars_nonnegative CHECK (text_chars >= 0)
  ,CONSTRAINT agent_session_materials_extraction_status_known CHECK (extraction_status IN
    ('idle','pending','running','done','failed'))
  ,CONSTRAINT agent_session_materials_extraction_attempts_nonnegative CHECK (extraction_attempts >= 0)
);

CREATE INDEX IF NOT EXISTS agent_session_materials_session_created_idx
  ON agent_session_materials (session_id, created_at);

CREATE INDEX IF NOT EXISTS agent_session_materials_extraction_queue_idx
  ON agent_session_materials (created_at)
  WHERE kind = 'source' AND extraction_status IN ('pending','running');

CREATE UNIQUE INDEX IF NOT EXISTS agent_session_materials_session_id_id_unique
  ON agent_session_materials (session_id, id);

-- Older schemas referenced derived_from by globally unique id only. Replace
-- that FK atomically so a derivative can never reference or cascade from a
-- source in another session. If legacy corruption exists, ADD CONSTRAINT
-- fails and rolls the block back instead of silently accepting unsafe rows.
DO $material_fk$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_session_materials_derived_from_fkey'
       AND conrelid = 'agent_session_materials'::regclass
  ) THEN
    ALTER TABLE agent_session_materials
      DROP CONSTRAINT agent_session_materials_derived_from_fkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_session_materials_derived_from_same_session_fkey'
       AND conrelid = 'agent_session_materials'::regclass
  ) THEN
    ALTER TABLE agent_session_materials
      ADD CONSTRAINT agent_session_materials_derived_from_same_session_fkey
      FOREIGN KEY (session_id, derived_from)
      REFERENCES agent_session_materials (session_id, id)
      ON DELETE CASCADE;
  END IF;
END;
$material_fk$;

CREATE TABLE IF NOT EXISTS agent_session_material_write_claims (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  material_id   TEXT NOT NULL,
  material_kind TEXT NOT NULL,
  derived_from  TEXT,
  object_slot   TEXT NOT NULL,
  object_key    TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'claimed',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_session_material_write_claims_kind_known CHECK (material_kind IN
    ('source','extraction','transcript','audio-track','image','web')),
  CONSTRAINT agent_session_material_write_claims_slot_known CHECK (object_slot IN ('text','raw')),
  CONSTRAINT agent_session_material_write_claims_state_known CHECK (state IN ('claimed','staged'))
);

CREATE INDEX IF NOT EXISTS agent_session_material_write_claims_session_state_idx
  ON agent_session_material_write_claims (session_id, state, created_at);

CREATE INDEX IF NOT EXISTS agent_session_material_write_claims_session_object_idx
  ON agent_session_material_write_claims (session_id, object_key);
`;

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(
      `@openmaic/storage: invalid agent-session-material table name ${JSON.stringify(identifier)}`,
    );
  }
  return `"${identifier}"`;
}

function resolveTableNames(
  overrides?: Partial<AgentSessionMaterialTableNames>,
): AgentSessionMaterialTableNames {
  const materials = overrides?.materials ?? DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES.materials;
  const names = {
    materials,
    writeClaims:
      overrides?.writeClaims ??
      (materials === DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES.materials
        ? DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES.writeClaims
        : `${materials}_write_claims`),
  };
  for (const name of Object.values(names)) quoteIdentifier(name);
  return names;
}

function schemaFor(names: AgentSessionMaterialTableNames): string {
  if (
    names.materials === DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES.materials &&
    names.writeClaims === DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES.writeClaims
  ) {
    return AGENT_SESSION_MATERIAL_PG_SCHEMA;
  }
  const s = quoteIdentifier(names.materials);
  const c = quoteIdentifier(names.writeClaims);
  const kindCheck = `${names.materials}_kind_known`;
  const charsCheck = `${names.materials}_text_chars_nonnegative`;
  const statusCheck = `${names.materials}_extraction_status_known`;
  const attemptsCheck = `${names.materials}_extraction_attempts_nonnegative`;
  const sessionIdx = `${names.materials}_session_created_idx`;
  const queueIdx = `${names.materials}_extraction_queue_idx`;
  const claimKindCheck = `${names.writeClaims}_kind_known`;
  const claimSlotCheck = `${names.writeClaims}_slot_known`;
  const claimStateCheck = `${names.writeClaims}_state_known`;
  const claimStateIdx = `${names.writeClaims}_session_state_idx`;
  const claimObjectIdx = `${names.writeClaims}_session_object_idx`;
  // Constraint/index names are rewritten first (they embed the default table
  // name), then the table-name occurrences themselves; only the CREATE TABLE
  // statement gets the quoted identifier.
  return AGENT_SESSION_MATERIAL_PG_SCHEMA.replaceAll(
    'agent_session_material_write_claims_kind_known',
    claimKindCheck,
  )
    .replaceAll('agent_session_material_write_claims_slot_known', claimSlotCheck)
    .replaceAll('agent_session_material_write_claims_state_known', claimStateCheck)
    .replaceAll('agent_session_material_write_claims_session_state_idx', claimStateIdx)
    .replaceAll('agent_session_material_write_claims_session_object_idx', claimObjectIdx)
    .replaceAll('agent_session_material_write_claims', names.writeClaims)
    .replaceAll('agent_session_materials_kind_known', kindCheck)
    .replaceAll('agent_session_materials_text_chars_nonnegative', charsCheck)
    .replaceAll('agent_session_materials_extraction_status_known', statusCheck)
    .replaceAll('agent_session_materials_extraction_attempts_nonnegative', attemptsCheck)
    .replaceAll('agent_session_materials_session_created_idx', sessionIdx)
    .replaceAll('agent_session_materials_extraction_queue_idx', queueIdx)
    .replaceAll('agent_session_materials', names.materials)
    .replaceAll(
      `CREATE TABLE IF NOT EXISTS ${names.writeClaims}`,
      `CREATE TABLE IF NOT EXISTS ${c}`,
    )
    .replaceAll(`CREATE TABLE IF NOT EXISTS ${names.materials}`, `CREATE TABLE IF NOT EXISTS ${s}`);
}

/** Create the backend-owned table when absent; existing schemas require migrations. */
export async function ensureAgentSessionMaterialSchema(
  queryable: Queryable,
  tableNames?: Partial<AgentSessionMaterialTableNames>,
): Promise<void> {
  const schema = schemaFor(resolveTableNames(tableNames));
  for (const statement of splitSqlStatements(schema)) await queryable.query(statement);
}

interface MaterialRow extends Record<string, unknown> {
  id: string;
  session_id: string;
  kind: string;
  title: string | null;
  source_url: string | null;
  text_asset_id: string | null;
  raw_asset_id: string | null;
  text_chars: number | string;
  derived_from: string | null;
  extraction_status: MaterialExtractionState['status'];
  extraction_attempts: number | string;
  extraction_error: string | null;
  extraction_stats: MaterialExtractionState['stats'] | null;
  extractor_version: string | null;
  extraction_lease_worker_id: string | null;
  extraction_lease_worker_pid: number | string | null;
  extraction_lease_heartbeat_at: number | string | null;
  created_at: Date | string;
}

interface MaterialWriteClaimRow extends Record<string, unknown> {
  id: string;
  session_id: string;
  material_id: string;
  material_kind: AgentSessionMaterialKind;
  derived_from: string | null;
  object_slot: AgentSessionMaterialWriteClaim['objectSlot'];
  object_key: string;
  state: AgentSessionMaterialWriteClaim['state'];
  created_at: Date | string;
}

function safeExtractionStats(value: MaterialExtractionState['stats'] | null) {
  if (!value || typeof value !== 'object') return undefined;
  return {
    chars: Number(value.chars),
    pages: Number(value.pages),
    imageCount: Number(value.imageCount),
    ...(value.truncated === undefined ? {} : { truncated: value.truncated === true }),
    ...(value.durationSec === undefined ? {} : { durationSec: Number(value.durationSec) }),
    ...(value.asrChunks === undefined ? {} : { asrChunks: Number(value.asrChunks) }),
  };
}

function mapRow(row: MaterialRow): AgentSessionMaterial {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind as AgentSessionMaterialKind,
    title: row.title,
    sourceUrl: row.source_url,
    textAssetId: row.text_asset_id,
    rawAssetId: row.raw_asset_id,
    textChars: Number(row.text_chars),
    derivedFrom: row.derived_from,
    extraction: {
      status: row.extraction_status,
      attempts: Number(row.extraction_attempts),
      ...(row.extraction_error
        ? {
            error: isMaterialExtractionErrorCode(row.extraction_error)
              ? row.extraction_error
              : 'MATERIAL_EXTRACTION_FAILED',
          }
        : {}),
      ...(row.extraction_stats ? { stats: safeExtractionStats(row.extraction_stats) } : {}),
      ...(row.extractor_version ? { extractorVersion: row.extractor_version } : {}),
    },
    createdAt: (row.created_at instanceof Date
      ? row.created_at
      : new Date(row.created_at)
    ).toISOString(),
  };
}

function mapWriteClaim(row: MaterialWriteClaimRow): AgentSessionMaterialWriteClaim {
  return {
    id: row.id,
    sessionId: row.session_id,
    materialId: row.material_id,
    materialKind: row.material_kind,
    derivedFrom: row.derived_from,
    objectSlot: row.object_slot,
    objectKey: row.object_key,
    state: row.state,
    createdAt: (row.created_at instanceof Date
      ? row.created_at
      : new Date(row.created_at)
    ).toISOString(),
  };
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23503'
  );
}

export class PgAgentSessionMaterialStore implements AgentSessionMaterialStore {
  private readonly queryable: Queryable;
  private readonly tableNames: AgentSessionMaterialTableNames;
  private readonly createId: () => string;
  private readonly createClaimId: () => string;
  private readonly now: () => Date;
  private readonly transactionHook?: WithTransaction;

  constructor(queryable: Queryable, options: PgAgentSessionMaterialStoreOptions = {}) {
    this.queryable = queryable;
    this.tableNames = resolveTableNames(options.tableNames);
    this.createId = options.createId ?? (() => createMaterialId());
    this.createClaimId = options.createClaimId ?? (() => createMaterialWriteClaimId());
    this.now = options.now ?? (() => new Date());
    this.transactionHook = options.withTransaction;
  }

  private get table(): string {
    return quoteIdentifier(this.tableNames.materials);
  }

  private get claimsTable(): string {
    return quoteIdentifier(this.tableNames.writeClaims);
  }

  async createMaterial(
    sessionId: string,
    input: CreateAgentSessionMaterialInput,
  ): Promise<AgentSessionMaterial> {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new AgentSessionMaterialError('invalid_input', 'session id must be a non-empty string');
    }
    if (!isAgentSessionMaterialKind(input.kind)) {
      throw new AgentSessionMaterialError(
        'invalid_input',
        `unknown material kind ${JSON.stringify(input.kind)}; expected one of ` +
          AGENT_SESSION_MATERIAL_KINDS.join(', '),
      );
    }
    const textChars = input.textChars ?? 0;
    if (!Number.isSafeInteger(textChars) || textChars < 0) {
      throw new AgentSessionMaterialError(
        'invalid_input',
        'textChars must be a non-negative safe integer',
      );
    }
    const id = input.id ?? this.createId();
    if (typeof id !== 'string' || id === '') {
      throw new AgentSessionMaterialError(
        'invalid_input',
        'material id must be a non-empty string',
      );
    }
    const createdAt = this.now();
    try {
      const { rows } = await this.queryable.query<MaterialRow>(
        `WITH active_session AS (
           SELECT id FROM agent_sessions
            WHERE id = $2 AND deleted_at IS NULL
            FOR UPDATE
         )
         INSERT INTO ${this.table}
           (id, session_id, kind, title, source_url, text_asset_id, raw_asset_id,
            text_chars, derived_from, extraction_status, created_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9,
                 CASE WHEN $3 = 'source' THEN 'idle' ELSE 'done' END, $10
         FROM active_session
         RETURNING *`,
        [
          id,
          sessionId,
          input.kind,
          input.title ?? null,
          input.sourceUrl ?? null,
          input.textAssetId ?? null,
          input.rawAssetId ?? null,
          textChars,
          input.derivedFrom ?? null,
          createdAt,
        ],
      );
      if (!rows[0]) {
        throw new AgentSessionMaterialError(
          'session_missing',
          `session ${JSON.stringify(sessionId)} does not exist`,
        );
      }
      return mapRow(rows[0]);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new AgentSessionMaterialError(
          'session_missing',
          `session ${JSON.stringify(sessionId)} does not exist`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async listMaterials(
    sessionId: string,
    options: ListAgentSessionMaterialsOptions = {},
  ): Promise<AgentSessionMaterial[]> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const params: unknown[] = [sessionId];
    let cursorSql = '';
    if (options.before !== undefined) {
      params.push(options.before);
      cursorSql = `
        AND (
          material.created_at < (SELECT created_at FROM ${this.table} WHERE id = $2 AND session_id = $1)
          OR (
            material.created_at = (SELECT created_at FROM ${this.table} WHERE id = $2 AND session_id = $1)
            AND material.id < $2
          )
        )`;
    }
    params.push(limit);
    const result = await this.queryable.query<MaterialRow>(
      `SELECT material.* FROM ${this.table} AS material
        INNER JOIN agent_sessions AS session ON session.id = material.session_id
        WHERE material.session_id = $1 AND session.deleted_at IS NULL${cursorSql}
        ORDER BY material.created_at DESC, material.id DESC
        LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapRow);
  }

  async getMaterial(sessionId: string, materialId: string): Promise<AgentSessionMaterial | null> {
    const result = await this.queryable.query<MaterialRow>(
      `SELECT material.* FROM ${this.table} AS material
        INNER JOIN agent_sessions AS session ON session.id = material.session_id
        WHERE material.id = $1 AND material.session_id = $2 AND session.deleted_at IS NULL
        LIMIT 1`,
      [materialId, sessionId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async deleteMaterial(
    sessionId: string,
    materialId: string,
  ): Promise<AgentSessionMaterial | null> {
    const result = await this.queryable.query<MaterialRow>(
      `DELETE FROM ${this.table} AS material
        USING agent_sessions AS session
        WHERE material.id = $1 AND material.session_id = $2
          AND session.id = material.session_id AND session.deleted_at IS NULL
        RETURNING material.*`,
      [materialId, sessionId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async getDeletedSessionMaterialsForCleanup(
    sessionId: string,
    ownerId: string,
  ): Promise<AgentSessionMaterial[] | null> {
    const owned = await this.queryable.query<{ id: string }>(
      `SELECT id FROM agent_sessions
        WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL`,
      [sessionId, ownerId],
    );
    if (!owned.rows[0]) return null;
    const result = await this.queryable.query<MaterialRow>(
      `SELECT * FROM ${this.table}
        WHERE session_id = $1 ORDER BY created_at, id`,
      [sessionId],
    );
    return result.rows.map(mapRow);
  }

  async purgeDeletedSessionMaterials(sessionId: string, ownerId: string): Promise<boolean> {
    const result = await this.queryable.query<{ id: string }>(
      `DELETE FROM ${this.table} AS material
        USING agent_sessions AS session
        WHERE material.session_id = $1
          AND session.id = material.session_id
          AND session.owner_id = $2
          AND session.deleted_at IS NOT NULL
        RETURNING material.id`,
      [sessionId, ownerId],
    );
    return result.rows.length > 0;
  }

  async claimMaterialWrite(
    sessionId: string,
    input: CreateAgentSessionMaterialWriteClaimInput,
  ): Promise<AgentSessionMaterialWriteClaim> {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new AgentSessionMaterialError('invalid_input', 'session id must be a non-empty string');
    }
    if (
      typeof input.materialId !== 'string' ||
      input.materialId === '' ||
      typeof input.objectKey !== 'string' ||
      input.objectKey === '' ||
      !isAgentSessionMaterialKind(input.materialKind) ||
      (input.objectSlot !== 'text' && input.objectSlot !== 'raw')
    ) {
      throw new AgentSessionMaterialError('invalid_input', 'invalid material write claim');
    }
    const result = await this.queryable.query<MaterialWriteClaimRow>(
      `WITH active_session AS (
         SELECT id FROM agent_sessions
          WHERE id = $2 AND deleted_at IS NULL
          FOR UPDATE
       )
       INSERT INTO ${this.claimsTable}
         (id, session_id, material_id, material_kind, derived_from,
          object_slot, object_key, state, created_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, 'claimed', $8
         FROM active_session
       RETURNING *`,
      [
        this.createClaimId(),
        sessionId,
        input.materialId,
        input.materialKind,
        input.derivedFrom ?? null,
        input.objectSlot,
        input.objectKey,
        this.now(),
      ],
    );
    if (!result.rows[0]) {
      throw new AgentSessionMaterialError(
        'session_missing',
        `session ${JSON.stringify(sessionId)} does not exist`,
      );
    }
    return mapWriteClaim(result.rows[0]);
  }

  async executeClaimedMaterialWrite(claimId: string, write: () => Promise<void>): Promise<boolean> {
    if (!this.transactionHook) {
      throw new Error('@openmaic/storage: material byte writes require withTransaction');
    }
    return this.transactionHook(async (tx) => {
      const claim = await tx.query<MaterialWriteClaimRow>(
        `SELECT claim.*
           FROM ${this.claimsTable} AS claim
           INNER JOIN agent_sessions AS session ON session.id = claim.session_id
          WHERE claim.id = $1 AND claim.state = 'claimed' AND session.deleted_at IS NULL
          FOR UPDATE OF claim, session`,
        [claimId],
      );
      if (!claim.rows[0]) return false;
      await write();
      const staged = await tx.query(
        `UPDATE ${this.claimsTable}
            SET state = 'staged'
          WHERE id = $1 AND state = 'claimed'
          RETURNING id`,
        [claimId],
      );
      if (staged.rows.length !== 1) {
        throw new Error('@openmaic/storage: material write claim changed during publish');
      }
      return true;
    });
  }

  async finalizeMaterialWrite(sessionId: string, claimId: string): Promise<boolean> {
    const result = await this.queryable.query(
      `WITH active_session AS (
         SELECT id FROM agent_sessions
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE
       )
       DELETE FROM ${this.claimsTable} AS claim
       USING active_session, ${this.table} AS material
       WHERE claim.id = $2 AND claim.session_id = active_session.id
         AND claim.state = 'staged'
         AND material.id = claim.material_id
         AND material.session_id = claim.session_id
         AND ((claim.object_slot = 'text' AND material.text_asset_id = claim.object_key)
           OR (claim.object_slot = 'raw' AND material.raw_asset_id = claim.object_key))
       RETURNING claim.id`,
      [sessionId, claimId],
    );
    return result.rows.length === 1;
  }

  async discardMaterialWrite(sessionId: string, claimId: string): Promise<boolean> {
    const result = await this.queryable.query(
      `DELETE FROM ${this.claimsTable}
        WHERE id = $1 AND session_id = $2
        RETURNING id`,
      [claimId, sessionId],
    );
    return result.rows.length === 1;
  }

  async getDeletedSessionMaterialWriteClaimsForCleanup(
    sessionId: string,
    ownerId: string,
  ): Promise<AgentSessionMaterialWriteClaim[] | null> {
    const owned = await this.queryable.query<{ id: string }>(
      `SELECT id FROM agent_sessions
        WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL`,
      [sessionId, ownerId],
    );
    if (!owned.rows[0]) return null;
    const result = await this.queryable.query<MaterialWriteClaimRow>(
      `SELECT * FROM ${this.claimsTable}
        WHERE session_id = $1 ORDER BY created_at, id`,
      [sessionId],
    );
    return result.rows.map(mapWriteClaim);
  }

  async purgeDeletedSessionMaterialWriteClaims(
    sessionId: string,
    ownerId: string,
  ): Promise<boolean> {
    const result = await this.queryable.query(
      `DELETE FROM ${this.claimsTable} AS claim
       USING agent_sessions AS session
       WHERE claim.session_id = $1
         AND session.id = claim.session_id
         AND session.owner_id = $2
         AND session.deleted_at IS NOT NULL
       RETURNING claim.id`,
      [sessionId, ownerId],
    );
    return result.rows.length > 0;
  }

  async enqueueExtraction(sessionId: string, materialId: string): Promise<boolean> {
    const result = await this.queryable.query(
      `UPDATE ${this.table} AS material
          SET extraction_status = 'pending', extraction_attempts = 0,
              extraction_error = NULL, extraction_stats = NULL,
              extractor_version = NULL, extraction_lease_worker_id = NULL,
              extraction_lease_worker_pid = NULL, extraction_lease_heartbeat_at = NULL
         FROM agent_sessions AS session
        WHERE material.id = $1 AND material.session_id = $2
          AND material.session_id = session.id AND session.deleted_at IS NULL
          AND material.kind = 'source'
          AND material.extraction_status IN ('idle', 'failed')
        RETURNING material.id`,
      [materialId, sessionId],
    );
    return result.rows.length > 0;
  }

  async claimNextExtraction(
    workerId: string,
    options: ClaimMaterialExtractionOptions,
  ): Promise<ClaimedMaterialExtraction | null> {
    if (!Number.isSafeInteger(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
      throw new AgentSessionMaterialError('invalid_input', 'leaseTtlMs must be a positive integer');
    }
    const now = this.now().getTime();
    const staleBefore = now - options.leaseTtlMs;
    const result = await this.queryable.query<MaterialRow>(
      `WITH candidate AS (
         SELECT material.id
           FROM ${this.table} AS material
           INNER JOIN agent_sessions AS session ON session.id = material.session_id
          WHERE session.deleted_at IS NULL AND material.kind = 'source'
            AND (material.extraction_status = 'pending'
              OR (material.extraction_status = 'running'
                AND material.extraction_lease_heartbeat_at < $1
                AND (material.extraction_lease_worker_id IS NULL
                  OR material.extraction_lease_worker_id <> $2)))
          ORDER BY material.created_at, material.id
          FOR UPDATE OF material SKIP LOCKED LIMIT 1
       )
       UPDATE ${this.table} AS material
          SET extraction_status = 'running', extraction_error = NULL,
              extraction_lease_worker_id = $2, extraction_lease_worker_pid = $3,
              extraction_lease_heartbeat_at = $4
         FROM candidate
        WHERE material.id = candidate.id
          AND (material.extraction_status = 'pending'
            OR (material.extraction_status = 'running'
              AND material.extraction_lease_heartbeat_at < $1
              AND (material.extraction_lease_worker_id IS NULL
                OR material.extraction_lease_worker_id <> $2)))
        RETURNING material.*`,
      [staleBefore, workerId, process.pid, now],
    );
    if (!result.rows[0]) return null;
    return { material: mapRow(result.rows[0]), workerId, heartbeatAt: now };
  }

  async heartbeatExtraction(materialId: string, workerId: string): Promise<boolean> {
    const result = await this.queryable.query(
      `UPDATE ${this.table}
          SET extraction_lease_heartbeat_at = $3
        WHERE id = $1 AND extraction_status = 'running'
          AND extraction_lease_worker_id = $2 RETURNING id`,
      [materialId, workerId, this.now().getTime()],
    );
    return result.rows.length > 0;
  }

  async completeExtraction(input: CompleteMaterialExtractionInput): Promise<boolean> {
    const derived = Array.isArray(input.derived) ? input.derived : [input.derived];
    const result = await this.queryable.query(
      `WITH active_source AS (
         SELECT material.id, material.session_id
           FROM ${this.table} AS material
           INNER JOIN agent_sessions AS session ON session.id = material.session_id
          WHERE material.id = $1 AND material.kind = 'source'
            AND material.extraction_status = 'running'
            AND material.extraction_lease_worker_id = $2
            AND session.deleted_at IS NULL
          FOR UPDATE OF material, session
       ), source AS (
         UPDATE ${this.table} AS material
             SET extraction_status = 'done', extraction_stats = $3::jsonb,
                 extractor_version = $4, extraction_error = NULL,
                 extraction_lease_worker_id = NULL, extraction_lease_worker_pid = NULL,
                 extraction_lease_heartbeat_at = NULL
            FROM active_source
           WHERE material.id = active_source.id
          RETURNING material.session_id
       ), removed AS (
         DELETE FROM ${this.table} AS derivative
          USING source
          WHERE derivative.derived_from = $1
            AND derivative.session_id = source.session_id
       ), derivative AS (
         SELECT * FROM unnest(
           $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::integer[]
         ) AS value(id, kind, title, text_asset_id, raw_asset_id, text_chars)
       )
       INSERT INTO ${this.table}
         (id, session_id, kind, title, text_asset_id, raw_asset_id, text_chars,
          derived_from, extraction_status, extraction_stats, extractor_version, created_at)
       SELECT derivative.id, source.session_id, derivative.kind, derivative.title,
              derivative.text_asset_id, derivative.raw_asset_id, derivative.text_chars,
              $1, 'done', $3::jsonb, $4, $11
         FROM source CROSS JOIN derivative
       RETURNING id`,
      [
        input.sourceId,
        input.workerId,
        JSON.stringify(input.stats),
        input.extractorVersion,
        derived.map((item) => item.id),
        derived.map((item) => item.kind),
        derived.map((item) => item.title ?? null),
        derived.map((item) => item.textAssetId ?? null),
        derived.map((item) => item.rawAssetId ?? null),
        derived.map((item) => item.textChars ?? 0),
        this.now(),
      ],
    );
    return result.rows.length === derived.length;
  }

  async settleExtractionFailure(
    materialId: string,
    workerId: string,
    error: MaterialExtractionErrorCode,
    retryable: boolean,
  ): Promise<MaterialExtractionFailureSettlement | null> {
    const result = await this.queryable.query<
      MaterialExtractionFailureSettlement & Record<string, unknown>
    >(
      `UPDATE ${this.table}
          SET extraction_status = CASE
                WHEN $4 AND extraction_attempts < $5 THEN 'pending' ELSE 'failed' END,
              extraction_attempts = CASE
                WHEN $4 AND extraction_attempts < $5 THEN extraction_attempts + 1
                ELSE extraction_attempts END,
              extraction_error = $3, extraction_stats = NULL,
              extraction_lease_worker_id = NULL, extraction_lease_worker_pid = NULL,
              extraction_lease_heartbeat_at = NULL
        WHERE id = $1 AND extraction_status = 'running'
          AND extraction_lease_worker_id = $2
        RETURNING extraction_status AS status, extraction_attempts AS attempts`,
      [materialId, workerId, error.slice(0, 4000), retryable, MAX_MATERIAL_EXTRACTION_RETRIES],
    );
    return result.rows[0] ?? null;
  }
}
