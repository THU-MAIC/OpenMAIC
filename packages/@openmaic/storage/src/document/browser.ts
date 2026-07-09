/**
 * Browser {@link DocumentStore} backend: `document` aggregates normalized across
 * three IndexedDB object stores (`stages` / `scenes` / `outlines`). Writes
 * validate against the scene gate (the DSL `validateScene` by default, or an
 * injected validator for app-widened scene kinds) and write scene rows (deleting
 * ones no longer present); reads reassemble and migrate the document forward. Matches
 * the Part 1 asset backend's idiom — an injectable `IDBFactory`, a memoized open
 * that clears on failure, and transactions that resolve on commit (not on the
 * request) so a write claims durability only once the store actually kept it.
 */
import {
  DSL_VERSION,
  dslVersionOf,
  migrate,
  needsMigration,
  validateScene,
  validateStage,
} from '@openmaic/dsl';
import type { Scene } from '@openmaic/dsl';
import type {
  DocumentStore,
  DocumentSummary,
  MaicDocument,
  SceneLike,
  SceneValidator,
} from './types.js';
import { reassembleDocument, splitDocument, type OutlineRow, type StageRow } from './adapter.js';

const STAGES = 'stages';
const SCENES = 'scenes';
const OUTLINES = 'outlines';
const SCENES_BY_STAGE = 'by-stage';

export interface BrowserDocumentStoreOptions {
  /** IndexedDB factory. Defaults to the ambient `indexedDB`. Injectable for tests. */
  indexedDB?: IDBFactory;
  /** Database name. Defaults to `maic-documents`. */
  dbName?: string;
  /**
   * Scene validator run at the write boundary. Defaults to the DSL
   * `validateScene` (universal `slide` / `quiz` kinds). An app persisting a
   * widened scene union (interactive / pbl / …) injects a validator that also
   * accepts its own kinds, so the gate stays fail-loud for them.
   */
  validateScene?: SceneValidator;
}

/** Promisify a single IndexedDB request. */
function reqP<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Throw a fail-loud error listing every validation issue, or pass. */
function assertValid(result: ReturnType<typeof validateStage>, label: string): void {
  if (result.valid) return;
  const detail = result.errors.map((e) => `${e.path || '/'}: ${e.message}`).join('; ');
  throw new Error(`@openmaic/storage: invalid ${label}: ${detail}`);
}

/**
 * Fail loud unless a scene is structurally storable in `stageId`'s partition —
 * the store's own key/sort invariants, enforced independently of the (possibly
 * app-injected) content validator:
 *
 * - `stageId` must match: it is the compound-key partition the row lands in, so a
 *   mismatch would store the scene where no read path for `stageId` can find it
 *   (silent data loss).
 * - `id` must be a string: the other half of the compound key.
 * - `order` must be a finite number: the read-time sort key. A non-number — or
 *   `NaN` / `Infinity`, which are `typeof number` — makes `a.order - b.order`
 *   return `NaN` and silently scrambles scene order on read.
 *
 * The DSL `validateScene` happens to check all three, but an app that injects its
 * own validator may not — so the store re-asserts them rather than trust the
 * content validator with its key/sort invariants.
 */
function assertStorableScene(scene: SceneLike, stageId: string): void {
  const s = scene as { id: unknown; stageId: unknown; order: unknown };
  if (typeof s.id !== 'string') {
    throw new Error(`@openmaic/storage: scene id must be a string, got ${JSON.stringify(s.id)}`);
  }
  if (s.stageId !== stageId) {
    throw new Error(
      `@openmaic/storage: scene ${JSON.stringify(s.id)} has stageId ` +
        `${JSON.stringify(s.stageId)} but belongs to document ${JSON.stringify(stageId)}`,
    );
  }
  if (typeof s.order !== 'number' || !Number.isFinite(s.order)) {
    throw new Error(
      `@openmaic/storage: scene ${JSON.stringify(s.id)} order must be a finite number, got ` +
        `${JSON.stringify(s.order)}`,
    );
  }
}

/**
 * True when a document / stage row is stamped *ahead* of this client's
 * `DSL_VERSION` (`needsMigration` false means version >= current; a version that
 * is also not equal to current is strictly greater). Such data was written by a
 * newer client; an older client must not overwrite it (see the write guards).
 * A non-object carries no version claim, so it is never "future".
 */
function isFutureVersioned(versioned: unknown): boolean {
  if (typeof versioned !== 'object' || versioned === null) return false;
  return !needsMigration(versioned) && dslVersionOf(versioned) !== DSL_VERSION;
}

/**
 * Migrate a document forward to the current DSL version, leaving the opaque,
 * app-owned `outline` untouched. The outline is not DSL-shaped, so migrations
 * must never see it — splitting it out here makes the "outline is not migrated"
 * contract literally true and stops a future migration transform from silently
 * dropping the snapshot while rebuilding the aggregate. Throws (via `migrate`)
 * if the document's version has no path up the ladder.
 *
 * Scenes (including an app-widened union) *do* stay inside the migrated core:
 * the DSL owns the scene contract, so its migrations are the authority on scene
 * shape and are expected to key on `scene.type` and pass app kinds through
 * untouched. This is the deliberate asymmetry with `outline`, which the DSL owns
 * no contract for at all.
 */
function migrateDocument<TScene extends SceneLike>(
  doc: MaicDocument<TScene>,
): MaicDocument<TScene> {
  const { outline, ...core } = doc;
  const migrated = migrate(core) as MaicDocument<TScene>;
  return outline === undefined ? migrated : { ...migrated, outline };
}

export class BrowserDocumentStore<
  TScene extends SceneLike = Scene,
> implements DocumentStore<TScene> {
  private readonly idb: IDBFactory;
  private readonly dbName: string;
  private readonly validateScene: SceneValidator;
  private dbPromise?: Promise<IDBDatabase>;

  constructor(options: BrowserDocumentStoreOptions = {}) {
    this.idb = options.indexedDB ?? globalThis.indexedDB;
    this.dbName = options.dbName ?? 'maic-documents';
    this.validateScene = options.validateScene ?? validateScene;
  }

  private openDb(): Promise<IDBDatabase> {
    // Do NOT cache a rejected open: a transient failure (private-mode IDB, a
    // one-off VersionError) would otherwise brick the store for the session.
    this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.idb.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STAGES)) {
          db.createObjectStore(STAGES, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(SCENES)) {
          // Compound key so scene ids need only be unique WITHIN a stage —
          // documents stay isolated even if two courses reuse a scene id.
          const scenes = db.createObjectStore(SCENES, { keyPath: ['stageId', 'id'] });
          scenes.createIndex(SCENES_BY_STAGE, 'stageId', { unique: false });
        }
        if (!db.objectStoreNames.contains(OUTLINES)) {
          db.createObjectStore(OUTLINES, { keyPath: 'stageId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      this.dbPromise = undefined;
      throw err;
    });
    return this.dbPromise;
  }

  /**
   * Run `body` inside one transaction, resolving with its return value on
   * commit. A throw from `body` aborts the transaction and rejects with that
   * error, so a failed multi-write leaves the stores untouched (atomicity).
   */
  private async txRun<T>(
    stores: string[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.openDb();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T;
      let failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(failure ?? tx.error);
      tx.onabort = () => reject(failure ?? tx.error);
      void (async () => {
        try {
          result = await body(tx);
        } catch (err) {
          failure = err;
          // The transaction may already be finishing; ignore a late abort throw.
          try {
            tx.abort();
          } catch {
            /* already inactive */
          }
        }
      })();
    });
  }

  async saveDocument(doc: MaicDocument<TScene>): Promise<void> {
    // Forward-compatibility: refuse to persist (and thereby downgrade) a document
    // written by a newer client. `loadDocument` returns such documents untouched;
    // saving one back would relabel its newer-shaped rows as this older version.
    if (isFutureVersioned(doc)) {
      throw new Error(
        `@openmaic/storage: refusing to save document ${JSON.stringify(doc.stage.id)} — it was ` +
          `written at DSL version ${JSON.stringify(dslVersionOf(doc))}, newer than this ` +
          `client's ${DSL_VERSION}`,
      );
    }
    // Normalize stale input forward to the current version — the same migration
    // `loadDocument` runs on read. An explicit older stamp (e.g. an import at a
    // prior version) is migrated up rather than blindly stamped current, and a
    // stamp with no path up the ladder fails loud, so a document is never
    // persisted mislabeled as a version it was not actually migrated to.
    const normalized = migrateDocument(doc);

    // Validate the (normalized) aggregate BEFORE opening a transaction, so an
    // invalid stage or scene fails loud without any partial write.
    assertValid(validateStage(normalized.stage), `stage ${normalized.stage.id}`);
    const stageId = normalized.stage.id;
    const seen = new Set<string>();
    for (const scene of normalized.scenes) {
      assertValid(this.validateScene(scene), `scene ${scene.id}`);
      // The scene's own stageId is the compound-key partition it lands in; a
      // scene whose stageId disagrees with its document would be written to a
      // partition no read path for this document sees. Fail loud rather than
      // silently lose it (validateScene checks stageId is a string, not that it
      // matches the parent).
      assertStorableScene(scene, stageId);
      // Two scenes sharing an id collapse to one compound key on write — the
      // second would silently overwrite the first. Reject the aggregate instead.
      if (seen.has(scene.id)) {
        throw new Error(
          `@openmaic/storage: duplicate scene id ${JSON.stringify(scene.id)} in document ${JSON.stringify(stageId)}`,
        );
      }
      seen.add(scene.id);
    }

    const { stageRow, sceneRows, outlineRow } = splitDocument(normalized);

    await this.txRun([STAGES, SCENES, OUTLINES], 'readwrite', async (tx) => {
      const stages = tx.objectStore(STAGES);
      // Read the stored stage row inside the write transaction (no TOCTOU) and
      // refuse to overwrite a document written by a newer client — the incoming
      // document may itself be current/unversioned, so the incoming-version
      // guard above does not catch a blind overwrite of newer stored data.
      const existingStage = await reqP<StageRow | undefined>(stages.get(stageId));
      if (existingStage && isFutureVersioned(existingStage)) {
        throw new Error(
          `@openmaic/storage: refusing to overwrite document ${JSON.stringify(stageId)} — the ` +
            `stored copy is at DSL version ${JSON.stringify(dslVersionOf(existingStage))}, newer ` +
            `than this client's ${DSL_VERSION}`,
        );
      }
      stages.put(stageRow);

      // Write every incoming scene, then delete the ones no longer present. We do
      // NOT diff-skip "unchanged" scenes: deciding a scene is unchanged means
      // reliably comparing opaque app content, which would require faithfully
      // reproducing IndexedDB's structured-clone equality (iteration order, sparse
      // arrays, expando properties, prototype, shared-reference topology) — a
      // false-positive minefield where a wrong "equal" silently drops an edit. A
      // redundant write is harmless; cheap per-scene incremental writes go through
      // `putScene`.
      const scenes = tx.objectStore(SCENES);
      const incomingIds = new Set(sceneRows.map((s) => s.id));
      for (const scene of sceneRows) scenes.put(scene);
      const existingKeys = await reqP<IDBValidKey[]>(
        scenes.index(SCENES_BY_STAGE).getAllKeys(stageId),
      );
      for (const key of existingKeys) {
        const id = Array.isArray(key) ? (key[1] as string) : (key as string);
        if (!incomingIds.has(id)) scenes.delete(key);
      }

      // A full-aggregate save with no outline means "no outline" — clear any.
      const outlines = tx.objectStore(OUTLINES);
      if (outlineRow) outlines.put(outlineRow);
      else outlines.delete(stageId);
    });
  }

  async loadDocument(stageId: string): Promise<MaicDocument<TScene> | null> {
    const rows = await this.txRun([STAGES, SCENES, OUTLINES], 'readonly', async (tx) => {
      const stageRow = await reqP<StageRow | undefined>(tx.objectStore(STAGES).get(stageId));
      if (!stageRow) return null;
      const sceneRows = await reqP<TScene[]>(
        tx.objectStore(SCENES).index(SCENES_BY_STAGE).getAll(stageId),
      );
      const outlineRow = await reqP<OutlineRow | undefined>(tx.objectStore(OUTLINES).get(stageId));
      return { stageRow, sceneRows, outlineRow };
    });
    if (!rows) return null;

    const document = reassembleDocument(rows.stageRow, rows.sceneRows, rows.outlineRow);
    // Migrate the aggregate forward (outline excluded); forward-versioned
    // documents pass through untouched (never downgraded).
    return migrateDocument(document);
  }

  async listDocuments(): Promise<DocumentSummary[]> {
    // Deliberately version-agnostic: the summary fields do not depend on the DSL
    // version and no content is migrated or returned here, so a corrupt/unknown
    // `dslVersion` stamp is not read — one bad row must not break the whole list
    // (it still fails loud when the document itself is loaded).
    return this.txRun([STAGES, SCENES], 'readonly', async (tx) => {
      const stageRows = await reqP<StageRow[]>(tx.objectStore(STAGES).getAll());
      const index = tx.objectStore(SCENES).index(SCENES_BY_STAGE);
      const summaries: DocumentSummary[] = [];
      for (const stage of stageRows) {
        const sceneCount = await reqP<number>(index.count(stage.id));
        summaries.push({
          id: stage.id,
          name: stage.name,
          createdAt: stage.createdAt,
          updatedAt: stage.updatedAt,
          sceneCount,
        });
      }
      return summaries;
    });
  }

  async deleteDocument(stageId: string): Promise<void> {
    // Whole-document removal is a deliberate, coarse user action, so it is
    // intentionally NOT version-guarded (unlike the incremental put/deleteScene
    // mutations): the caller means to discard the entire document regardless of
    // the DSL version it was written at.
    await this.txRun([STAGES, SCENES, OUTLINES], 'readwrite', async (tx) => {
      tx.objectStore(STAGES).delete(stageId);
      tx.objectStore(OUTLINES).delete(stageId);
      const scenes = tx.objectStore(SCENES);
      const keys = await reqP<IDBValidKey[]>(scenes.index(SCENES_BY_STAGE).getAllKeys(stageId));
      for (const key of keys) scenes.delete(key);
    });
  }

  async putScene(stageId: string, scene: TScene): Promise<void> {
    assertValid(this.validateScene(scene), `scene ${scene.id}`);
    assertStorableScene(scene, stageId);
    await this.txRun([STAGES, SCENES], 'readwrite', async (tx) => {
      const stages = tx.objectStore(STAGES);
      const stageRow = await reqP<StageRow | undefined>(stages.get(stageId));
      if (!stageRow) {
        throw new Error(
          `@openmaic/storage: cannot putScene into missing document ${JSON.stringify(stageId)}`,
        );
      }
      // An incremental scene write must land in an already-current document. If
      // the stored document is stale, its other scenes have not been migrated,
      // so marking the whole document current off one write would strand them
      // below the migrate-on-read line; if it is newer, this client must not
      // downgrade it. Either way, require a full load + save to normalize first.
      if (dslVersionOf(stageRow) !== DSL_VERSION) {
        throw new Error(
          `@openmaic/storage: cannot putScene into document ${JSON.stringify(stageId)} at DSL ` +
            `version ${JSON.stringify(dslVersionOf(stageRow))} — load and save it to bring it ` +
            `to ${DSL_VERSION} first`,
        );
      }
      tx.objectStore(SCENES).put(scene);
    });
  }

  async getScene(stageId: string, sceneId: string): Promise<TScene | null> {
    const stageRow = await this.txRun([STAGES], 'readonly', (tx) =>
      reqP<StageRow | undefined>(tx.objectStore(STAGES).get(stageId)),
    );
    if (!stageRow) return null;

    // Fast path when the document needs no migration (current OR ahead of us):
    // read the one row. A stale (older) document routes through the whole-
    // document migrate path below, so a lone scene is never returned
    // un-migrated (per the whole-document migration granularity).
    if (!needsMigration(stageRow)) {
      const scene = await this.txRun([SCENES], 'readonly', (tx) =>
        reqP<TScene | undefined>(tx.objectStore(SCENES).get([stageId, sceneId])),
      );
      return scene ?? null;
    }
    const document = await this.loadDocument(stageId);
    return document?.scenes.find((s) => s.id === sceneId) ?? null;
  }

  async deleteScene(stageId: string, sceneId: string): Promise<void> {
    await this.txRun([STAGES, SCENES], 'readwrite', async (tx) => {
      const stageRow = await reqP<StageRow | undefined>(tx.objectStore(STAGES).get(stageId));
      // Idempotent: nothing to delete if the document is already gone.
      if (!stageRow) return;
      // Deleting a scene is an incremental mutation, so it takes the same guard
      // as putScene: the stored document must be current. This client must not
      // partially edit a newer-versioned document (which loadDocument otherwise
      // preserves untouched), nor mutate a stale one before it is normalized.
      // A whole-document removal (deleteDocument) is a deliberate coarse action
      // and is intentionally NOT version-guarded.
      if (dslVersionOf(stageRow) !== DSL_VERSION) {
        throw new Error(
          `@openmaic/storage: cannot deleteScene from document ${JSON.stringify(stageId)} at DSL ` +
            `version ${JSON.stringify(dslVersionOf(stageRow))} — load and save it to bring it ` +
            `to ${DSL_VERSION} first`,
        );
      }
      tx.objectStore(SCENES).delete([stageId, sceneId]);
    });
  }
}
