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
    /** The same store, pinned to one already-open transaction. See its use. */
    private readonly pinnedToTransaction: (queryable: Queryable) => PgDocumentStore<TScene, TStage>,
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

  /**
   * Retire a course: tombstone it, and release the assets it was holding.
   *
   * Deletion here is a tombstone, not a delete. `stage_meta` is what records
   * that the id is permanently retired, and it references
   * `document_stages(id) ON DELETE CASCADE`, so removing the document row
   * would take the tombstone with it and let the retired id be claimed again.
   * The document rows therefore stay, and the package's `deleteDocument` can
   * never be called from here.
   *
   * What the document rows must NOT keep is the assets they name. Reference
   * rows carry no foreign key to `document_stages`, so nothing releases them
   * on their own: a retired course would hold every asset it ever named alive
   * forever, and against the principal's quota. `withdrawAssetReferences` is
   * the half of the package's delete that releases assets without deleting
   * anything, so the two facts — the id is retired, and its assets are free —
   * are recorded together.
   *
   * All of it in one transaction, deliberately. A withdrawal that committed
   * beside a tombstone that did not would free the assets of a course still
   * live and still naming them; the rollback is what makes that unreachable.
   */
  async deleteDocument(stageId: string): Promise<void> {
    await this.tagged({ stageId, mode: 'delete' }, () =>
      this.runTransaction(async (queryable) => {
        // By the time this body runs, `runTransaction` has already taken the
        // `stage_meta` row `FOR UPDATE` and refused a foreign owner, so the
        // delete is decided before anything below is written.
        await tombstoneStageMeta(queryable, stageId);
        await queryable.query('UPDATE document_stages SET folder_id = NULL WHERE id = $1', [
          stageId,
        ]);
        // Pinned to this transaction rather than called on `this.inner`.
        //
        // `withdrawAssetReferences` opens its own write transaction through
        // the hook its store was built with, and ours checks out a fresh
        // connection and re-runs the ownership gate on it. From inside this
        // transaction that second connection would contend for the very rows
        // this one already holds — the stage row just updated, and the
        // `stage_meta` row the gate locked — so it would wait out the
        // package's lock budget and fail as contention every single time,
        // while this transaction sat idle waiting for it. PostgreSQL cannot
        // see that cycle: one backend is blocked, the other is merely
        // idle-in-transaction.
        //
        // The package warns that a pass-through hook is invalid because
        // concurrent calls would interleave inside one transaction. That is
        // not this: the store below is constructed here, used for exactly one
        // call, and dropped, on a connection no one else holds.
        const released = await this.pinnedToTransaction(queryable).withdrawAssetReferences(stageId);
        if (!released) {
          // Unreachable as the schema stands: the gate above found a
          // `stage_meta` row for this owner, that table's foreign key
          // guarantees the document row exists, and both are written with the
          // same owner in the same transaction. So this means the tombstone
          // and the document disagree about who owns the stage. The tombstone
          // is still correct and must stand — rolling it back over a
          // bookkeeping mismatch would leave the course undeletable — but the
          // assets stayed behind and someone should know.
          console.warn(
            `Tombstoned stage ${stageId} but withdrew no asset references: the document row is ` +
              `absent or not owned by ${this.ownerId}. Its registry entries will not be ` +
              `reclaimed.`,
          );
        }
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
  const innerOptions = {
    ownerId: options.ownerId,
    validateScene: options.validateScene,
    validateStage: options.validateStage,
    // The reference half of the asset lifecycle, on for the same reason the
    // asset schema is always ensured: this store is the write path that commits
    // an allocation and records what a document claims, and the collector's
    // entry pass -- always scheduled where server persistence exists -- reads
    // exactly that. There is no configuration in this application where one
    // runs without the other. It is also what `withdrawAssetReferences`
    // requires, and `deleteDocument` calls that on every retirement.
    trackAssetReferences: true,
  };
  const inner = new PgDocumentStore<TScene, TStage>(queryable, {
    ...innerOptions,
    withTransaction,
  });
  /**
   * The same store over one already-open transaction, for a caller that is
   * inside one and needs a package write to join it rather than open its own.
   * Single-use by construction; see the call in `deleteDocument`.
   */
  const pinnedToTransaction = (pinned: Queryable): PgDocumentStore<TScene, TStage> =>
    new PgDocumentStore<TScene, TStage>(pinned, {
      ...innerOptions,
      withTransaction: (body) => body(pinned),
    });
  return new OwnerBoundDocumentStore(
    inner,
    pending,
    withTransaction,
    queryable,
    options.ownerId,
    pinnedToTransaction,
  );
}
