import type { Scene, Stage } from '@openmaic/dsl';
import {
  PgDocumentStore,
  type Queryable,
  type WithTransaction,
} from '@openmaic/storage/document/pg';
import type {
  DocumentFolder,
  DocumentFolderStore,
  DocumentStore,
  DocumentSummary,
  MaicDocument,
  SceneLike,
  SceneValidator,
  StageValidator,
} from '@openmaic/storage';

import { claimStageMeta, StageAccessError, tombstoneStageMeta } from './stage-meta';

export interface PoolClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

export interface TransactionSource {
  connect(): Promise<PoolClientLike>;
}

export interface OwnerBoundDocumentStoreOptions {
  pool: TransactionSource;
  ownerId: string;
  validateScene: SceneValidator;
  validateStage: StageValidator;
  /** Runner-only lease fence, evaluated inside every mutation transaction. */
  mutationFence?: (queryable: Queryable) => Promise<void>;
}

type OwnershipMode = 'create' | 'mutate' | 'read' | 'delete' | 'library';
interface PendingOperation {
  stageId?: string;
  mode: OwnershipMode;
}

interface RawOwnershipRow extends Record<string, unknown> {
  owner_id: string;
  deleted_at: Date | string | null;
}

function queryableFor(connection: Pick<PoolClientLike, 'query'>): Queryable {
  return {
    async query<TRow extends Record<string, unknown>>(text: string, params?: unknown[]) {
      const result = await connection.query(text, params);
      return { rows: result.rows as TRow[] };
    },
  };
}

class OwnerBoundDocumentStore<TScene extends SceneLike, TStage extends Stage>
  implements DocumentStore<TScene, TStage>, DocumentFolderStore
{
  constructor(
    private readonly inner: PgDocumentStore<TScene, TStage>,
    private readonly pending: { operation?: PendingOperation },
    private readonly runTransaction: WithTransaction,
    private readonly queryable: Queryable,
    private readonly ownerId: string,
  ) {}

  private async tagged<T>(operation: PendingOperation, body: () => Promise<T>): Promise<T> {
    this.pending.operation = operation;
    try {
      return await body();
    } finally {
      this.pending.operation = undefined;
    }
  }

  saveDocument(doc: MaicDocument<TScene, TStage>): Promise<void> {
    return this.tagged({ stageId: doc.stage.id, mode: 'create' }, () =>
      this.inner.saveDocument(doc),
    );
  }

  putStage(stageId: string, stage: TStage): Promise<void> {
    return this.tagged({ stageId, mode: 'mutate' }, () => this.inner.putStage(stageId, stage));
  }

  putScene(stageId: string, scene: TScene): Promise<void> {
    return this.tagged({ stageId, mode: 'mutate' }, () => this.inner.putScene(stageId, scene));
  }

  deleteScene(stageId: string, sceneId: string): Promise<void> {
    return this.tagged({ stageId, mode: 'mutate' }, () => this.inner.deleteScene(stageId, sceneId));
  }

  async deleteDocument(stageId: string): Promise<void> {
    await this.tagged({ stageId, mode: 'delete' }, () =>
      this.runTransaction(async (queryable) => {
        await tombstoneStageMeta(queryable, stageId);
        await queryable.query('UPDATE document_stages SET folder_id = NULL WHERE id = $1', [
          stageId,
        ]);
      }),
    );
  }

  async loadDocument(stageId: string): Promise<MaicDocument<TScene, TStage> | null> {
    return this.readGated(stageId, () => this.inner.loadDocument(stageId));
  }

  async getScene(stageId: string, sceneId: string): Promise<TScene | null> {
    return this.readGated(stageId, () => this.inner.getScene(stageId, sceneId));
  }

  /** The trigger-maintained freshness manifest is a read: capability-by-id. */
  async readFreshnessManifest(stageId: string) {
    return this.readGated(stageId, () => this.inner.readFreshnessManifest(stageId));
  }

  private async readGated<T>(stageId: string, body: () => Promise<T>): Promise<T | null> {
    try {
      return await this.tagged({ stageId, mode: 'read' }, body);
    } catch (error) {
      if (error instanceof StageAccessError) return null;
      throw error;
    }
  }

  async listDocuments(folderId?: string): Promise<DocumentSummary[]> {
    const [documents, live] = await Promise.all([
      this.inner.listDocuments(folderId),
      this.queryable.query<{ stage_id: string } & Record<string, unknown>>(
        'SELECT stage_id FROM stage_meta WHERE owner_id = $1 AND deleted_at IS NULL',
        [this.ownerId],
      ),
    ]);
    const liveIds = new Set(live.rows.map((row) => row.stage_id));
    return documents.filter((document) => liveIds.has(document.id));
  }

  createFolder(folderId: string, name: string, limit?: number) {
    return this.tagged({ mode: 'library' }, () => this.inner.createFolder(folderId, name, limit));
  }

  listFolders(): Promise<DocumentFolder[]> {
    return this.inner.listFolders();
  }

  moveDocumentToFolder(stageId: string, folderId: string): Promise<boolean> {
    return this.tagged({ stageId, mode: 'mutate' }, () =>
      this.inner.moveDocumentToFolder(stageId, folderId),
    );
  }

  renameFolder(id: string, name: string): Promise<DocumentFolder | null> {
    return this.tagged({ mode: 'library' }, () => this.inner.renameFolder(id, name));
  }

  deleteFolder(
    id: string,
    mode: 'ungroup' | 'remove',
  ): Promise<{ removedStageIds: string[] } | null> {
    return this.tagged({ mode: 'library' }, () => this.inner.deleteFolder(id, mode));
  }

  setStageFolder(stageId: string, folderId: string | null): Promise<boolean> {
    return this.tagged({ stageId, mode: 'mutate' }, () =>
      this.inner.setStageFolder(stageId, folderId),
    );
  }
}

export function createOwnerBoundDocumentStore<
  TScene extends SceneLike = Scene,
  TStage extends Stage = Stage,
>(options: OwnerBoundDocumentStoreOptions): DocumentStore<TScene, TStage> & DocumentFolderStore {
  const pending: { operation?: PendingOperation } = {};

  const withTransaction: WithTransaction = async (body) => {
    const client = await options.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      try {
        const queryable = queryableFor(client);
        const operation = pending.operation;
        if (operation && operation.mode !== 'read') await options.mutationFence?.(queryable);
        if (operation?.stageId) {
          const lock = operation.mode === 'read' ? 'FOR SHARE' : 'FOR UPDATE';
          const result = await queryable.query<RawOwnershipRow>(
            `SELECT owner_id, deleted_at FROM stage_meta WHERE stage_id = $1 ${lock}`,
            [operation.stageId],
          );
          const row = result.rows[0];
          if (row) {
            if (operation.mode !== 'read' && row.owner_id !== options.ownerId) {
              throw new StageAccessError(operation.stageId, options.ownerId, 'foreign');
            }
            if (row.deleted_at !== null && operation.mode !== 'delete') {
              throw new StageAccessError(operation.stageId, options.ownerId, 'tombstoned');
            }
          } else if (operation.mode === 'create') {
            const occupied = await queryable.query<{ exists: boolean } & Record<string, unknown>>(
              'SELECT EXISTS(SELECT 1 FROM document_stages WHERE id = $1) AS exists',
              [operation.stageId],
            );
            if (occupied.rows[0]?.exists) {
              throw new StageAccessError(operation.stageId, options.ownerId, 'reserved-document');
            }
          } else {
            throw new StageAccessError(operation.stageId, options.ownerId, 'unclaimed');
          }
        }

        const result = await body(queryable);
        if (operation?.mode === 'create') {
          await claimStageMeta(queryable, operation.stageId!, options.ownerId);
        }
        if (operation && operation.mode !== 'read') await options.mutationFence?.(queryable);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally {
      client.release();
    }
  };

  const queryable: Queryable = {
    async query<TRow extends Record<string, unknown>>(text: string, params?: unknown[]) {
      const client = await options.pool.connect();
      try {
        return await queryableFor(client).query<TRow>(text, params);
      } finally {
        client.release();
      }
    },
  };
  const inner = new PgDocumentStore<TScene, TStage>(queryable, {
    withTransaction,
    ownerId: options.ownerId,
    validateScene: options.validateScene,
    validateStage: options.validateStage,
  });
  return new OwnerBoundDocumentStore(inner, pending, withTransaction, queryable, options.ownerId);
}
