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
  DocumentSummary,
  MaicDocument,
  SceneLike,
  SceneValidator,
  StageValidator,
} from './types.js';
import { DocumentNotFoundError, DocumentVersionError } from './types.js';
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
}

/** Idempotent schema for the PostgreSQL document backend. */
export const DOCUMENT_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS document_stages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  interactive_mode BOOLEAN,
  task_engine_mode BOOLEAN,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  data JSONB NOT NULL
);

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
`;

/**
 * Create the tables owned by this backend when absent. Safe to call repeatedly;
 * changing an existing table requires a real migration.
 */
export async function ensureDocumentSchema(queryable: Queryable): Promise<void> {
  // Keep Queryable minimal and PGlite-compatible: issue one statement at a time.
  for (const sql of DOCUMENT_PG_SCHEMA.split(';')) {
    const statement = sql.trim();
    if (statement !== '') await queryable.query(statement);
  }
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

export class PgDocumentStore<
  TScene extends SceneLike = Scene,
  TStage extends Stage = Stage,
> implements DocumentStore<TScene, TStage> {
  private readonly queryable: Queryable;
  private readonly transactionHook: WithTransaction;
  private readonly validateScene: SceneValidator;
  private readonly validateStage: StageValidator;

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
  }

  private async transaction<T>(body: (queryable: Queryable) => Promise<T>): Promise<T> {
    return this.transactionHook(body);
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
    await queryable.query(
      `INSERT INTO document_stages
         (id, name, description, interactive_mode, task_engine_mode, created_at, updated_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             interactive_mode = EXCLUDED.interactive_mode,
             task_engine_mode = EXCLUDED.task_engine_mode,
             created_at = EXCLUDED.created_at,
             updated_at = EXCLUDED.updated_at,
             data = EXCLUDED.data`,
      [
        stageRow.id,
        stageRow.name,
        stageRow.description ?? null,
        stageRow.interactiveMode ?? null,
        stageRow.taskEngineMode ?? null,
        stageRow.createdAt,
        stageRow.updatedAt,
        encodeJson(stageRow, `document stage ${JSON.stringify(stageRow.id)}`),
      ],
    );
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

  async listDocuments(): Promise<DocumentSummary[]> {
    const result = await this.queryable.query<SummaryRow>(
      `SELECT stages.id,
              stages.name,
              stages.description,
              stages.interactive_mode,
              stages.task_engine_mode,
              stages.created_at,
              stages.updated_at,
              COUNT(scenes.id)::text AS scene_count
         FROM document_stages AS stages
         LEFT JOIN document_scenes AS scenes ON scenes.stage_id = stages.id
        GROUP BY stages.id
        ORDER BY stages.id ASC`,
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
    }));
  }

  async deleteDocument(stageId: string): Promise<void> {
    if (!isPgQueryableKey(stageId)) return;
    // One statement; both child tables are removed by their FK cascades.
    await this.queryable.query('DELETE FROM document_stages WHERE id = $1', [stageId]);
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
