/**
 * PostgreSQL DocumentStore backend over the same injected query surface as the
 * runtime backend. Full stage and scene values live in JSONB so widened app
 * shapes round-trip without the SQL schema knowing their fields. The stage's
 * version-independent picker metadata and each scene's order are duplicated in
 * ordinary columns: listDocuments never needs to decode content (or its version
 * stamp), and ordered reads do not depend on JSON operators.
 *
 * `withTransaction` must check out a fresh connection and open a transaction
 * for every call, pin every query in `body` to it, then commit or roll back and
 * release it. READ COMMITTED isolation is assumed. JSON payloads are restricted
 * to values that round-trip losslessly through JSONB.
 */
import {
  DSL_VERSION,
  DSL_VERSION_KEY,
  dslVersionOf,
  migrate,
  needsMigration,
  validateScene,
  validateStage,
} from '@openmaic/dsl';
import type { Scene, Stage } from '@openmaic/dsl';
import { reassembleDocument, splitDocument, type OutlineRow, type StageRow } from './adapter.js';
import type {
  DocumentStore,
  DocumentFolder,
  DocumentFolderStore,
  DocumentSummary,
  MaicDocument,
  SceneLike,
  SceneValidator,
  StageFreshnessManifest,
  StageFreshnessManifestStore,
  StageValidator,
} from './types.js';
import { DocumentFolderLimitError, DocumentNotFoundError, DocumentVersionError } from './types.js';
import { assertJsonValue, isLosslessJsonString } from '../runtime/json-value.js';
import type { Queryable, WithTransaction } from '../runtime/pg.js';

export type { QueryResult, Queryable, WithTransaction } from '../runtime/pg.js';

export interface PgDocumentStoreOptions {
  /**
   * On every call, checks out a fresh connection, opens a transaction, pins
   * every query in `body` to it, then commits or rolls back and releases it.
   */
  withTransaction: WithTransaction;
  /** Scene write-boundary validator. Defaults to the DSL validateScene. */
  validateScene?: SceneValidator;
  /** Stage write-boundary validator. Defaults to the DSL validateStage. */
  validateStage?: StageValidator;
  /** Restrict writes, listings, and folders to this owner. Reads remain id-capable. */
  ownerId?: string;
}

/** Idempotent schema for the PostgreSQL document backend. */
export const DOCUMENT_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS document_folders (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, normalized_name)
);

ALTER TABLE document_folders
  ADD COLUMN IF NOT EXISTS folder_order DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS document_folders_owner_order_idx
  ON document_folders (owner_id, folder_order, id);

CREATE TABLE IF NOT EXISTS document_stages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  interactive_mode BOOLEAN,
  task_engine_mode BOOLEAN,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  owner_id TEXT,
  folder_id TEXT,
  data JSONB NOT NULL
);

ALTER TABLE document_stages
  ADD COLUMN IF NOT EXISTS owner_id TEXT;

ALTER TABLE document_stages
  ADD COLUMN IF NOT EXISTS folder_id TEXT;

CREATE INDEX IF NOT EXISTS document_stages_owner_idx
  ON document_stages (owner_id, id) WHERE owner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS document_stages_owner_folder_idx
  ON document_stages (owner_id, folder_id, id)
  WHERE owner_id IS NOT NULL AND folder_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  scene_order DOUBLE PRECISION NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (stage_id, id)
);

CREATE INDEX IF NOT EXISTS document_scenes_stage_order_idx
  ON document_scenes (stage_id, scene_order, id);

CREATE TABLE IF NOT EXISTS document_outlines (
  stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
  data JSONB NOT NULL
);

-- Per-scene monotonic revision signal, at the DB layer (ported from the
-- reference implementation's migration 0071).
--
-- WHY THE DB LAYER: course content has several write seams that share no
-- application-level signal (HTTP routes, agent tools, jobs, migration
-- scripts, manual psql). Only a trigger can make "wrote but never signaled"
-- unexpressible. These companion tables and triggers keep a monotonic
-- per-stage revision and a per-scene revision on every insert/update/delete
-- of document_stages / document_scenes. Companion tables instead of columns
-- keep the document tables' authoritative DDL untouched.
--
-- LOCK ORDER INVARIANT: the scene trigger bumps document_stage_revision (SR)
-- BEFORE document_scene_revision (SCR) — the same order saveDocument uses
-- (stage upsert first, then per-scene upserts). Any future code that writes
-- these two companion tables must take SR before SCR, or the deadlock (40P01)
-- between concurrent stage-first and scene-first writers comes back.
--
-- NOTIFY: each bump emits a JSON route {kind:'stage',stageId} on the
-- agent-event wakeup channel (the same channel the reference's agent event
-- notify bus LISTENs on), so a stage notification wakes exactly the
-- subscribers listening for that stage. The payload is built with
-- json_build_object — never hand-concatenated, because a stageId containing
-- quotes or backslashes would yield invalid JSON.
--
-- NOTIFY SUPPRESSION SWITCH: both triggers check
-- current_setting('openmaic.suppress_stage_notify', true) before pg_notify.
-- Batch/backfill writers MUST run SET LOCAL openmaic.suppress_stage_notify =
-- 'on' inside each batch transaction: the revision still bumps, only the
-- notification is skipped. NOTE: SET LOCAL outside a transaction block only
-- emits a warning and has NO effect.
--
-- TRUNCATE DOES NOT FIRE ROW TRIGGERS: a TRUNCATE reset of document_scenes /
-- document_stages leaves the companion revision rows behind, so any TRUNCATE
-- reset must also truncate document_scene_revision and
-- document_stage_revision.
--
-- IDEMPOTENT BY CONSTRUCTION: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION, DROP TRIGGER IF EXISTS — replayable in any environment.

CREATE TABLE IF NOT EXISTS document_stage_revision (
  stage_id TEXT PRIMARY KEY NOT NULL,
  rev BIGINT DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS document_scene_revision (
  stage_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  rev BIGINT DEFAULT 0 NOT NULL,
  CONSTRAINT document_scene_revision_pkey PRIMARY KEY (stage_id, scene_id)
);

CREATE OR REPLACE FUNCTION openmaic_bump_scene_revision() RETURNS trigger AS $$
DECLARE
  v_stage_id text;
  v_scene_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_stage_id := OLD.stage_id;
    v_scene_id := OLD.id;
  ELSE
    v_stage_id := NEW.stage_id;
    v_scene_id := NEW.id;
  END IF;
  -- LOCK ORDER INVARIANT: SR row BEFORE the SCR row (see the header comment).
  INSERT INTO document_stage_revision (stage_id, rev)
  VALUES (v_stage_id, 1)
  ON CONFLICT (stage_id) DO UPDATE SET rev = document_stage_revision.rev + 1;
  INSERT INTO document_scene_revision (stage_id, scene_id, rev)
  VALUES (v_stage_id, v_scene_id, 1)
  ON CONFLICT (stage_id, scene_id) DO UPDATE SET rev = document_scene_revision.rev + 1;
  IF coalesce(current_setting('openmaic.suppress_stage_notify', true), '') <> 'on' THEN
    PERFORM pg_notify('openmaic_agent_event_wakeup', json_build_object('kind', 'stage', 'stageId', v_stage_id)::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION openmaic_bump_stage_revision() RETURNS trigger AS $$
DECLARE
  v_stage_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_stage_id := OLD.id;
  ELSE
    v_stage_id := NEW.id;
  END IF;
  INSERT INTO document_stage_revision (stage_id, rev)
  VALUES (v_stage_id, 1)
  ON CONFLICT (stage_id) DO UPDATE SET rev = document_stage_revision.rev + 1;
  IF coalesce(current_setting('openmaic.suppress_stage_notify', true), '') <> 'on' THEN
    PERFORM pg_notify('openmaic_agent_event_wakeup', json_build_object('kind', 'stage', 'stageId', v_stage_id)::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS openmaic_scene_revision_trigger ON document_scenes;

CREATE TRIGGER openmaic_scene_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON document_scenes
FOR EACH ROW EXECUTE FUNCTION openmaic_bump_scene_revision();

DROP TRIGGER IF EXISTS openmaic_stage_revision_trigger ON document_stages;

CREATE TRIGGER openmaic_stage_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON document_stages
FOR EACH ROW EXECUTE FUNCTION openmaic_bump_stage_revision();
`;

/**
 * Split a DDL string into individual statements. A plain `split(';')` would
 * carve the `BEGIN ... END;` blocks inside the dollar-quoted plpgsql trigger
 * bodies into bogus statements, so the splitter skips over single-quoted
 * strings, double-quoted identifiers, `$$...$$` / `$tag$...$tag$` bodies, and
 * `--` line comments and slash-star block comments.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const end = sql.length;
  while (i < end) {
    const rest = sql.slice(i);
    const ch = sql[i];
    if (ch === ';') {
      statements.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (ch === '-' && rest.startsWith('--')) {
      const newline = rest.indexOf('\n');
      const lineEnd = newline === -1 ? end : i + newline + 1;
      current += sql.slice(i, lineEnd);
      i = lineEnd;
      continue;
    }
    if (ch === '/' && rest.startsWith('/*')) {
      const close = rest.indexOf('*/', 2);
      const blockEnd = close === -1 ? end : i + close + 2;
      current += sql.slice(i, blockEnd);
      i = blockEnd;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // Single-quoted string literal or double-quoted identifier; the quote
      // is escaped by doubling, and an unterminated run consumes the rest.
      current += ch;
      i += 1;
      while (i < end) {
        current += sql[i];
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(rest)?.[0];
      if (tag) {
        const close = rest.indexOf(tag, tag.length);
        if (close !== -1) {
          current += rest.slice(0, close + tag.length);
          i += close + tag.length;
          continue;
        }
      }
    }
    current += ch;
    i += 1;
  }
  return statements.map((statement) => statement.trim()).filter((statement) => statement !== '');
}

/**
 * Create the tables owned by this backend when absent. Safe to call repeatedly;
 * changing an existing table requires a real migration.
 */
export async function ensureDocumentSchema(queryable: Queryable): Promise<void> {
  // Keep Queryable minimal and PGlite-compatible: issue one statement at a time.
  for (const statement of splitSqlStatements(DOCUMENT_PG_SCHEMA)) {
    await queryable.query(statement);
  }
}

const STAGE_REV_SQL = `
  SELECT rev
    FROM document_stage_revision
   WHERE stage_id = $1
`;

const SCENES_SQL = `
  SELECT s.id,
         s.scene_order,
         COALESCE(sr.rev, 0) AS rev
    FROM document_scenes s
    LEFT JOIN document_scene_revision sr
      ON sr.stage_id = s.stage_id
     AND sr.scene_id = s.id
   WHERE s.stage_id = $1
   ORDER BY s.scene_order ASC, s.id ASC
`;

/**
 * Read the freshness manifest for one stage: the stage's monotonic revision
 * plus every live scene's id/order/rev, produced by the triggers provisioned
 * in `DOCUMENT_PG_SCHEMA`. A stage with no revision row yet reads as `rev: 0`
 * (written before the triggers existed, or never written since); a scene the
 * trigger never bumped also reads 0. Callers gate existence/visibility first
 * (the owner-bound store method does), so this function assumes the stage
 * exists and does not re-check it. Kept free of driver imports so the whole
 * read is unit-testable against any queryable.
 */
export async function readStageFreshnessManifest(
  stageId: string,
  queryable: Queryable,
): Promise<StageFreshnessManifest> {
  const [stageRows, sceneRows] = await Promise.all([
    queryable.query<{ rev: number | string }>(STAGE_REV_SQL, [stageId]),
    queryable.query<{ id: string; scene_order: number | string; rev: number | string }>(
      SCENES_SQL,
      [stageId],
    ),
  ]);

  return {
    rev: stageRows.rows[0] === undefined ? 0 : Number(stageRows.rows[0].rev),
    scenes: sceneRows.rows.map((row) => ({
      id: row.id,
      order: Number(row.scene_order),
      rev: Number(row.rev),
    })),
  };
}

interface StoredJsonRow extends Record<string, unknown> {
  data: unknown;
}

interface StoredSceneRow extends StoredJsonRow {
  id: string;
}

interface SummaryRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  interactive_mode: boolean | null;
  task_engine_mode: boolean | null;
  created_at: number | string;
  updated_at: number | string;
  scene_count: number | string;
  folder_id: string | null;
}

interface FolderRow extends Record<string, unknown> {
  id: string;
  name: string;
  folder_order: number | string;
  created_at: number | string;
  updated_at: number | string;
}

function assertValid(
  result: { valid: true } | { valid: false; errors: { path: string; message: string }[] },
  label: string,
): void {
  if (result.valid) return;
  const detail = result.errors.map((error) => `${error.path || '/'}: ${error.message}`).join('; ');
  throw new Error(`@openmaic/storage: invalid ${label}: ${detail}`);
}

function decodeJson<T>(value: unknown): T {
  // node-postgres and PGlite decode JSONB for us. A host adapter may instead
  // return object/array JSON as text, which is unambiguous for stage and scene
  // payloads. Do not parse scalar strings: an opaque outline is allowed to be a
  // string, and a corrupt stage scalar should reach the plain-object check.
  if (typeof value === 'string' && /^[\s]*[{\[]/.test(value)) {
    return JSON.parse(value) as T;
  }
  return value as T;
}

function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeJson(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('value is not JSON-serializable');
    return encoded;
  } catch (error) {
    throw new Error(`@openmaic/storage: ${label} is not JSON-serializable`, { cause: error });
  }
}

function isFutureVersioned(versioned: unknown): boolean {
  if (typeof versioned !== 'object' || versioned === null) return false;
  return !needsMigration(versioned) && dslVersionOf(versioned) !== DSL_VERSION;
}

function migrateDocument<TScene extends SceneLike, TStage extends Stage>(
  doc: MaicDocument<TScene, TStage>,
): MaicDocument<TScene, TStage> {
  const { outline, ...core } = doc;
  const migrated = migrate(core) as MaicDocument<TScene, TStage>;
  return outline === undefined ? migrated : { ...migrated, outline };
}

function assertStorableScene(scene: SceneLike, stageId: string): void {
  const candidate = scene as { id: unknown; stageId: unknown; order: unknown };
  if (typeof candidate.id !== 'string') {
    throw new Error(
      `@openmaic/storage: scene id must be a string, got ${JSON.stringify(candidate.id)}`,
    );
  }
  if (candidate.stageId !== stageId) {
    throw new Error(
      `@openmaic/storage: scene ${JSON.stringify(candidate.id)} has stageId ` +
        `${JSON.stringify(candidate.stageId)} but belongs to document ${JSON.stringify(stageId)}`,
    );
  }
  if (typeof candidate.order !== 'number' || !Number.isFinite(candidate.order)) {
    throw new Error(
      `@openmaic/storage: scene ${JSON.stringify(candidate.id)} order must be a finite number, ` +
        `got ${JSON.stringify(candidate.order)}`,
    );
  }
}

function isPgQueryableKey(value: string): boolean {
  return isLosslessJsonString(value);
}

export class PgDocumentStore<TScene extends SceneLike = Scene, TStage extends Stage = Stage>
  implements DocumentStore<TScene, TStage>, DocumentFolderStore, StageFreshnessManifestStore
{
  private readonly queryable: Queryable;
  private readonly transactionHook: WithTransaction;
  private readonly validateScene: SceneValidator;
  private readonly validateStage: StageValidator;
  private readonly ownerId: string | null;
  private readonly options: PgDocumentStoreOptions;

  constructor(queryable: Queryable, options: PgDocumentStoreOptions) {
    if (typeof options?.withTransaction !== 'function') {
      throw new Error(
        '@openmaic/storage: withTransaction is required and must pin a fresh connection and ' +
          'transaction for every call; reusing a shared client lets concurrent transactions ' +
          'interleave',
      );
    }
    this.queryable = queryable;
    this.transactionHook = options.withTransaction;
    this.validateScene = options.validateScene ?? validateScene;
    this.validateStage = options.validateStage ?? validateStage;
    if (options.ownerId !== undefined && !isPgQueryableKey(options.ownerId)) {
      throw new Error('@openmaic/storage: PgDocumentStore ownerId must be lossless JSON text');
    }
    this.ownerId = options.ownerId ?? null;
    this.options = options;
  }

  /** Bind document writes, listings, and folders to one trusted owner identity. */
  forOwner(ownerId: string): PgDocumentStore<TScene, TStage> {
    return new PgDocumentStore(this.queryable, { ...this.options, ownerId });
  }

  private scopePredicate(alias = '', ownerParameter = 1): string {
    const column = alias === '' ? 'owner_id' : `${alias}.owner_id`;
    return this.ownerId === null ? `${column} IS NULL` : `${column} = $${ownerParameter}`;
  }

  private scopeParams(stageId?: string): unknown[] {
    return this.ownerId === null
      ? stageId === undefined
        ? []
        : [stageId]
      : stageId === undefined
        ? [this.ownerId]
        : [stageId, this.ownerId];
  }

  private async transaction<T>(body: (queryable: Queryable) => Promise<T>): Promise<T> {
    return this.transactionHook(body);
  }

  private requireOwner(operation: string): string {
    if (this.ownerId === null) {
      throw new Error(`@openmaic/storage: ${operation} requires an owner-bound document store`);
    }
    return this.ownerId;
  }

  private async loadStage(
    queryable: Queryable,
    stageId: string,
    lock: 'share' | 'update' | false = false,
  ): Promise<StageRow<TStage> | undefined> {
    const suffix = lock === 'share' ? ' FOR SHARE' : lock === 'update' ? ' FOR UPDATE' : '';
    const result = await queryable.query<StoredJsonRow>(
      `SELECT data
         FROM document_stages
        WHERE id = $1${suffix}`,
      [stageId],
    );
    const storedRow = result.rows[0];
    if (!storedRow) return undefined;
    const decoded = decodeJson<unknown>(storedRow.data);
    if (!isPlainObject(decoded)) {
      throw new Error(
        `@openmaic/storage: corrupt stored row for document ${JSON.stringify(stageId)}: ` +
          'data must be a plain object',
      );
    }
    return decoded as StageRow<TStage>;
  }

  private async loadRows(
    queryable: Queryable,
    stageId: string,
    lock: 'share' | 'update' = 'share',
  ): Promise<
    { stageRow: StageRow<TStage>; sceneRows: TScene[]; outlineRow?: OutlineRow } | undefined
  > {
    const stageRow = await this.loadStage(queryable, stageId, lock);
    if (!stageRow) return undefined;
    const scenes = await queryable.query<StoredJsonRow>(
      `SELECT data
         FROM document_scenes
        WHERE stage_id = $1
        ORDER BY scene_order ASC, id ASC`,
      [stageId],
    );
    const outline = await queryable.query<StoredJsonRow>(
      `SELECT data
         FROM document_outlines
        WHERE stage_id = $1`,
      [stageId],
    );
    const sceneRows = scenes.rows.map((row) => decodeJson<TScene>(row.data));
    const outlineRow = outline.rows[0]
      ? { stageId, outline: decodeJson<unknown>(outline.rows[0].data) }
      : undefined;
    return { stageRow, sceneRows, outlineRow };
  }

  private currentVersionError(
    operation: string,
    stageId: string,
    stageRow: StageRow<TStage>,
  ): DocumentVersionError {
    return new DocumentVersionError(
      stageId,
      'not-current',
      stageRow[DSL_VERSION_KEY],
      `@openmaic/storage: cannot ${operation} document ${JSON.stringify(stageId)} at DSL ` +
        `version ${JSON.stringify(dslVersionOf(stageRow))} — load and save it to bring it ` +
        `to ${DSL_VERSION} first`,
    );
  }

  private validateForSave(
    doc: MaicDocument<TScene, TStage>,
  ): ReturnType<typeof splitDocument<TScene, TStage>> {
    assertValid(this.validateStage(doc.stage), `stage ${doc.stage.id}`);
    const stageId = doc.stage.id;
    const seen = new Set<string>();
    for (const scene of doc.scenes) {
      assertValid(this.validateScene(scene), `scene ${scene.id}`);
      assertStorableScene(scene, stageId);
      if (seen.has(scene.id)) {
        throw new Error(
          `@openmaic/storage: duplicate scene id ${JSON.stringify(scene.id)} in document ` +
            JSON.stringify(stageId),
        );
      }
      seen.add(scene.id);
    }
    const rows = splitDocument(doc);
    assertJsonValue(rows.stageRow, `document stage ${JSON.stringify(stageId)}`);
    for (const scene of rows.sceneRows) {
      assertJsonValue(scene, `document scene ${JSON.stringify(scene.id)}`);
    }
    if (rows.outlineRow) {
      assertJsonValue(rows.outlineRow.outline, `document outline ${JSON.stringify(stageId)}`);
    }
    return rows;
  }

  private async persistStage(queryable: Queryable, stageRow: StageRow<TStage>): Promise<void> {
    const result = await queryable.query<{ id: string }>(
      `INSERT INTO document_stages
         (id, name, description, interactive_mode, task_engine_mode, created_at, updated_at,
          owner_id, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             interactive_mode = EXCLUDED.interactive_mode,
             task_engine_mode = EXCLUDED.task_engine_mode,
             created_at = EXCLUDED.created_at,
             updated_at = EXCLUDED.updated_at,
             data = EXCLUDED.data
       WHERE document_stages.owner_id IS NOT DISTINCT FROM EXCLUDED.owner_id
       RETURNING id`,
      [
        stageRow.id,
        stageRow.name,
        stageRow.description ?? null,
        stageRow.interactiveMode ?? null,
        stageRow.taskEngineMode ?? null,
        stageRow.createdAt,
        stageRow.updatedAt,
        this.ownerId,
        encodeJson(stageRow, `document stage ${JSON.stringify(stageRow.id)}`),
      ],
    );
    if (result.rows.length === 0) {
      throw new DocumentNotFoundError(
        stageRow.id,
        `@openmaic/storage: document ${JSON.stringify(stageRow.id)} belongs to another scope`,
      );
    }
  }

  async saveDocument(doc: MaicDocument<TScene, TStage>): Promise<void> {
    if (isFutureVersioned(doc)) {
      throw new DocumentVersionError(
        doc.stage.id,
        'future',
        doc.dslVersion,
        `@openmaic/storage: refusing to save document ${JSON.stringify(doc.stage.id)} — it was ` +
          `written at DSL version ${JSON.stringify(dslVersionOf(doc))}, newer than this ` +
          `client's ${DSL_VERSION}`,
      );
    }
    const normalized = migrateDocument(doc);
    const { stageRow, sceneRows, outlineRow } = this.validateForSave(normalized);
    const stageId = stageRow.id;

    await this.transaction(async (queryable) => {
      const existingStage = await this.loadStage(queryable, stageId, 'update');
      if (existingStage && isFutureVersioned(existingStage)) {
        throw new DocumentVersionError(
          stageId,
          'future',
          existingStage[DSL_VERSION_KEY],
          `@openmaic/storage: refusing to overwrite document ${JSON.stringify(stageId)} — the ` +
            `stored copy is at DSL version ${JSON.stringify(dslVersionOf(existingStage))}, newer ` +
            `than this client's ${DSL_VERSION}`,
        );
      }

      await this.persistStage(queryable, stageRow);
      const existingScenes = await queryable.query<StoredSceneRow>(
        `SELECT id, data
           FROM document_scenes
          WHERE stage_id = $1`,
        [stageId],
      );
      const incomingIds = new Set(sceneRows.map((scene) => scene.id));
      for (const scene of sceneRows) {
        await queryable.query(
          `INSERT INTO document_scenes (stage_id, id, scene_order, data)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (stage_id, id) DO UPDATE
             SET scene_order = EXCLUDED.scene_order,
                 data = EXCLUDED.data`,
          [
            stageId,
            scene.id,
            scene.order,
            encodeJson(scene, `document scene ${JSON.stringify(scene.id)}`),
          ],
        );
      }
      for (const scene of existingScenes.rows) {
        if (!incomingIds.has(scene.id)) {
          await queryable.query('DELETE FROM document_scenes WHERE stage_id = $1 AND id = $2', [
            stageId,
            scene.id,
          ]);
        }
      }

      if (outlineRow) {
        await queryable.query(
          `INSERT INTO document_outlines (stage_id, data)
           VALUES ($1, $2::jsonb)
           ON CONFLICT (stage_id) DO UPDATE SET data = EXCLUDED.data`,
          [stageId, encodeJson(outlineRow.outline, `document outline ${JSON.stringify(stageId)}`)],
        );
      } else {
        await queryable.query('DELETE FROM document_outlines WHERE stage_id = $1', [stageId]);
      }
    });
  }

  async loadDocument(stageId: string): Promise<MaicDocument<TScene, TStage> | null> {
    if (!isPgQueryableKey(stageId)) return null;
    const rows = await this.transaction((queryable) => this.loadRows(queryable, stageId));
    if (!rows) return null;
    return migrateDocument(reassembleDocument(rows.stageRow, rows.sceneRows, rows.outlineRow));
  }

  async readFreshnessManifest(stageId: string): Promise<StageFreshnessManifest | null> {
    if (!isPgQueryableKey(stageId)) return null;
    return this.transaction(async (queryable) => {
      // Existence and ownership gate, exactly like loadDocument: a foreign or
      // missing stage answers the same null. The revision read itself is
      // un-scoped (readStageFreshnessManifest assumes the stage exists).
      const scoped = await queryable.query<{ id: string }>(
        `SELECT id
           FROM document_stages
          WHERE id = $1 AND ${this.scopePredicate('', 2)}`,
        this.scopeParams(stageId),
      );
      if (scoped.rows.length === 0) return null;
      return readStageFreshnessManifest(stageId, queryable);
    });
  }

  async createFolder(
    folderId: string,
    name: string,
    limit = 50,
  ): Promise<{ folder: DocumentFolder; reused: boolean }> {
    const ownerId = this.requireOwner('createFolder');
    if (!isPgQueryableKey(folderId) || !isPgQueryableKey(name)) {
      throw new Error('@openmaic/storage: folder id and name must be lossless JSON text');
    }
    const normalizedName = name.toLocaleLowerCase('en-US');
    return this.transaction(async (queryable) => {
      const existing = await queryable.query<FolderRow>(
        `SELECT id, name, folder_order, created_at, updated_at
           FROM document_folders
          WHERE owner_id = $1 AND normalized_name = $2
          LIMIT 1`,
        [ownerId, normalizedName],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        return {
          folder: {
            id: row.id,
            name: row.name,
            order: Number(row.folder_order),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
          },
          reused: true,
        };
      }
      const count = await queryable.query<{ count: number | string }>(
        'SELECT COUNT(*)::text AS count FROM document_folders WHERE owner_id = $1',
        [ownerId],
      );
      if (Number(count.rows[0]?.count ?? 0) >= limit) throw new DocumentFolderLimitError(limit);
      const now = Date.now();
      // Same order rule as the local model: a new folder goes after the
      // current maximum (folders are displayed by `order` ascending).
      const maxOrder = await queryable.query<{ max: number | string | null }>(
        `SELECT MAX(folder_order)::text AS max
           FROM document_folders
          WHERE owner_id = $1`,
        [ownerId],
      );
      const order = Number(maxOrder.rows[0]?.max ?? -1) + 1;
      const inserted = await queryable.query<FolderRow>(
        `INSERT INTO document_folders
           (owner_id, id, name, normalized_name, folder_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (owner_id, normalized_name) DO UPDATE
           SET normalized_name = EXCLUDED.normalized_name
         RETURNING id, name, folder_order, created_at, updated_at`,
        [ownerId, folderId, name, normalizedName, order, now],
      );
      const row = inserted.rows[0]!;
      return {
        folder: {
          id: row.id,
          name: row.name,
          order: Number(row.folder_order),
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        },
        reused: row.id !== folderId,
      };
    });
  }

  async listFolders(): Promise<DocumentFolder[]> {
    const ownerId = this.requireOwner('listFolders');
    const result = await this.queryable.query<FolderRow>(
      `SELECT id, name, folder_order, created_at, updated_at
         FROM document_folders
        WHERE owner_id = $1
        ORDER BY folder_order ASC, id ASC`,
      [ownerId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      order: Number(row.folder_order),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  async renameFolder(id: string, name: string): Promise<DocumentFolder | null> {
    const ownerId = this.requireOwner('renameFolder');
    if (!isPgQueryableKey(id) || !isPgQueryableKey(name)) {
      throw new Error('@openmaic/storage: folder id and name must be lossless JSON text');
    }
    const normalizedName = name.toLocaleLowerCase('en-US');
    const updated = await this.queryable.query<FolderRow>(
      `UPDATE document_folders
          SET name = $3, normalized_name = $4, updated_at = $5
        WHERE owner_id = $1 AND id = $2
        RETURNING id, name, folder_order, created_at, updated_at`,
      [ownerId, id, name, normalizedName, Date.now()],
    );
    const row = updated.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      order: Number(row.folder_order),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async deleteFolder(
    id: string,
    mode: 'ungroup' | 'remove',
  ): Promise<{ removedStageIds: string[] } | null> {
    const ownerId = this.requireOwner('deleteFolder');
    if (!isPgQueryableKey(id)) return null;
    return this.transaction(async (queryable) => {
      // Capture the filed documents before the folder row goes away. Every
      // document in this folder is owner-scoped (the folder is owner-scoped),
      // so the captured ids are exactly the caller's own courses.
      let removedStageIds: string[] = [];
      if (mode === 'remove') {
        const members = await queryable.query<{ id: string }>(
          `SELECT id
             FROM document_stages
            WHERE owner_id = $1 AND folder_id = $2
            ORDER BY id ASC`,
          [ownerId, id],
        );
        removedStageIds = members.rows.map((row) => row.id);
      }
      // Clear the membership of every filed document: 'ungroup' keeps the
      // courses (they become unfiled), 'remove' hands them to the caller's
      // cascade without leaving dangling folder pointers behind.
      await queryable.query(
        `UPDATE document_stages
            SET folder_id = NULL
          WHERE owner_id = $1 AND folder_id = $2`,
        [ownerId, id],
      );
      const deleted = await queryable.query<{ id: string }>(
        `DELETE FROM document_folders
          WHERE owner_id = $1 AND id = $2
          RETURNING id`,
        [ownerId, id],
      );
      if (deleted.rows.length === 0) return null;
      return { removedStageIds };
    });
  }

  async moveDocumentToFolder(stageId: string, folderId: string): Promise<boolean> {
    return this.setStageFolder(stageId, folderId);
  }

  async setStageFolder(stageId: string, folderId: string | null): Promise<boolean> {
    const ownerId = this.requireOwner('setStageFolder');
    if (!isPgQueryableKey(stageId)) return false;
    if (folderId === null) {
      // Un-file: a missing membership row already means unfiled, so this is
      // idempotent and never refuses (the route's contract for folderId null).
      await this.queryable.query(
        `UPDATE document_stages
            SET folder_id = NULL
          WHERE id = $1 AND owner_id = $2`,
        [stageId, ownerId],
      );
      return true;
    }
    if (!isPgQueryableKey(folderId)) return false;
    const result = await this.queryable.query<{ id: string }>(
      `UPDATE document_stages AS stages
          SET folder_id = $2
        WHERE stages.id = $1
          AND stages.owner_id = $3
          AND EXISTS (
            SELECT 1
              FROM document_folders AS folders
             WHERE folders.owner_id = $3 AND folders.id = $2
          )
      RETURNING stages.id`,
      [stageId, folderId, ownerId],
    );
    return result.rows.length === 1;
  }

  async listDocuments(folderId?: string): Promise<DocumentSummary[]> {
    if (folderId !== undefined && (!isPgQueryableKey(folderId) || this.ownerId === null)) return [];
    const folderFilter = folderId === undefined ? '' : ` AND stages.folder_id = $2`;
    const result = await this.queryable.query<SummaryRow>(
      `SELECT stages.id,
              stages.name,
              stages.description,
              stages.interactive_mode,
              stages.task_engine_mode,
              stages.created_at,
              stages.updated_at,
              stages.folder_id,
              COUNT(scenes.id)::text AS scene_count
         FROM document_stages AS stages
         LEFT JOIN document_scenes AS scenes ON scenes.stage_id = stages.id
        WHERE ${this.scopePredicate('stages')}${folderFilter}
        GROUP BY stages.id
        ORDER BY stages.id ASC`,
      folderId === undefined ? this.scopeParams() : [this.ownerId, folderId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      ...(row.description === null ? {} : { description: row.description }),
      ...(row.interactive_mode === null ? {} : { interactiveMode: row.interactive_mode }),
      ...(row.task_engine_mode === null ? {} : { taskEngineMode: row.task_engine_mode }),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      sceneCount: Number(row.scene_count),
      ...(row.folder_id === null ? {} : { folderId: row.folder_id }),
    }));
  }

  async deleteDocument(stageId: string): Promise<void> {
    if (!isPgQueryableKey(stageId)) return;
    // One statement; both child tables are removed by their FK cascades.
    await this.queryable.query(
      `DELETE FROM document_stages WHERE id = $1 AND ${this.scopePredicate('', 2)}`,
      this.scopeParams(stageId),
    );
  }

  async putStage(stageId: string, stage: TStage): Promise<void> {
    assertValid(this.validateStage(stage), `stage ${stage.id}`);
    if (stage.id !== stageId) {
      throw new Error(
        `@openmaic/storage: stage ${JSON.stringify(stage.id)} does not belong to document ` +
          JSON.stringify(stageId),
      );
    }
    const stageRow = { ...stage, [DSL_VERSION_KEY]: DSL_VERSION } as StageRow<TStage>;
    assertJsonValue(stageRow, `document stage ${JSON.stringify(stageId)}`);
    await this.transaction(async (queryable) => {
      const stored = await this.loadStage(queryable, stageId, 'update');
      if (!stored) {
        throw new DocumentNotFoundError(
          stageId,
          `@openmaic/storage: cannot putStage into missing document ${JSON.stringify(stageId)}`,
        );
      }
      if (dslVersionOf(stored) !== DSL_VERSION) {
        throw this.currentVersionError('putStage into', stageId, stored);
      }
      await this.persistStage(queryable, stageRow);
    });
  }

  async putScene(stageId: string, scene: TScene): Promise<void> {
    assertValid(this.validateScene(scene), `scene ${scene.id}`);
    assertStorableScene(scene, stageId);
    assertJsonValue(scene, `document scene ${JSON.stringify(scene.id)}`);
    await this.transaction(async (queryable) => {
      const stored = await this.loadStage(queryable, stageId, 'update');
      if (!stored) {
        throw new DocumentNotFoundError(
          stageId,
          `@openmaic/storage: cannot putScene into missing document ${JSON.stringify(stageId)}`,
        );
      }
      if (dslVersionOf(stored) !== DSL_VERSION) {
        throw this.currentVersionError('putScene into', stageId, stored);
      }
      await queryable.query(
        `INSERT INTO document_scenes (stage_id, id, scene_order, data)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (stage_id, id) DO UPDATE
           SET scene_order = EXCLUDED.scene_order,
               data = EXCLUDED.data`,
        [
          stageId,
          scene.id,
          scene.order,
          encodeJson(scene, `document scene ${JSON.stringify(scene.id)}`),
        ],
      );
    });
  }

  async getScene(stageId: string, sceneId: string): Promise<TScene | null> {
    if (!isPgQueryableKey(stageId) || !isPgQueryableKey(sceneId)) return null;
    return this.transaction(async (queryable) => {
      const stageRow = await this.loadStage(queryable, stageId, 'share');
      if (!stageRow) return null;
      if (!needsMigration(stageRow)) {
        const result = await queryable.query<StoredJsonRow>(
          `SELECT data
             FROM document_scenes
            WHERE stage_id = $1 AND id = $2`,
          [stageId, sceneId],
        );
        return result.rows[0] ? decodeJson<TScene>(result.rows[0].data) : null;
      }
      const scenes = await queryable.query<StoredJsonRow>(
        `SELECT data
           FROM document_scenes
          WHERE stage_id = $1
          ORDER BY scene_order ASC, id ASC`,
        [stageId],
      );
      const outline = await queryable.query<StoredJsonRow>(
        'SELECT data FROM document_outlines WHERE stage_id = $1',
        [stageId],
      );
      const outlineRow = outline.rows[0]
        ? { stageId, outline: decodeJson<unknown>(outline.rows[0].data) }
        : undefined;
      const document = migrateDocument(
        reassembleDocument(
          stageRow,
          scenes.rows.map((row) => decodeJson<TScene>(row.data)),
          outlineRow,
        ),
      );
      return document.scenes.find((scene) => scene.id === sceneId) ?? null;
    });
  }

  async deleteScene(stageId: string, sceneId: string): Promise<void> {
    if (!isPgQueryableKey(stageId) || !isPgQueryableKey(sceneId)) return;
    await this.transaction(async (queryable) => {
      const stored = await this.loadStage(queryable, stageId, 'update');
      if (!stored) return;
      if (dslVersionOf(stored) !== DSL_VERSION) {
        throw this.currentVersionError('deleteScene from', stageId, stored);
      }
      await queryable.query('DELETE FROM document_scenes WHERE stage_id = $1 AND id = $2', [
        stageId,
        sceneId,
      ]);
    });
  }
}
