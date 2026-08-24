import { DSL_VERSION, migrate } from '@openmaic/dsl';
import { BrowserKVStore, type DocumentStore, type KVStore } from '@openmaic/storage';
import isEqual from 'lodash/isEqual';

import type { AppScene } from '@/lib/types/stage';
import { createLogger } from '@/lib/logger';
import { omitUndefinedObjectMembers } from '@/lib/persistence/plain-json';
import { withRuntimeStorageSharedLock } from '@/lib/utils/chat-storage-lock';
import {
  db,
  type SceneRecord,
  type StageOutlinesRecord,
  type StageRecord,
} from '@/lib/utils/database';

import {
  canonicalizeLegacyOutline,
  canonicalizeLegacyScene,
  canonicalizeLegacyStage,
} from './canonicalize';
import {
  loadCurrentSceneValue,
  saveCurrentSceneValue,
  type CurrentSceneValue,
} from './current-scene';
import type { AppDocument, AppDocumentOutline, AppStage } from './persistence-types';
import { readGeneration } from './storage-generation';
import { getDocumentStore } from './store';
import { validateAppScene, validateAppStage } from './validators';
import { collectStageAssetRefs } from '@/lib/media/collect-stage-asset-refs';

export interface LegacyDocumentSnapshot {
  stage: StageRecord;
  scenes: SceneRecord[];
  outline?: StageOutlinesRecord;
}

export interface LegacyDocumentStore {
  read(stageId: string): Promise<LegacyDocumentSnapshot | null>;
  listStages(): Promise<StageRecord[]>;
}

export interface DocumentMigrationDeps {
  store?: DocumentStore<AppScene, AppStage>;
  kv?: KVStore;
  legacyStore?: LegacyDocumentStore;
  lockManager?: LockManager | null;
  migrateDsl?: (document: unknown) => unknown;
  /**
   * App-side legacy asset-reference converter (#1007 part 2, step c). Runs on
   * every document this layer loads under the document lock, before the
   * document is handed out or saved at the current DSL version: the pure DSL
   * ladder cannot read local bytes or probe URLs, so ingesting legacy media
   * bytes and collapsing `audioUrl`/`audioId` pairs happens here. Injectable
   * for tests; the default wires Dexie legacy tables and the app asset pool.
   */
  convertAssetRefs?: AssetRefConverter;
  /** The mutation callback acquires the runtime shared epoch before writing. */
  storageSharedLockHeld?: boolean;
}

export interface DocumentMutationOptions {
  /**
   * A wholesale replacement (import, backup restore) overwrites the whole
   * aggregate. Skipping the eager conversion avoids allocating assets for
   * content the callback will immediately replace -- those allocations would
   * otherwise be orphaned by the very save that lands next.
   */
  mode?: 'update' | 'replace';
}

/**
 * Rewrites a loaded document's legacy media references to allocated asset ids,
 * returning the input by identity when nothing converted. The optional ledger
 * collects every id the pass freshly allocates, so the caller can roll the
 * side effects back if the converted document is never committed.
 */
export type AssetRefConverter = (document: AppDocument, ledger?: string[]) => Promise<AppDocument>;

export interface DocumentAccessResult {
  document: AppDocument | null;
  legacyCurrentSceneId?: string;
  readOnlyLegacy: boolean;
}

interface MigrationMarker {
  sourceUpdatedAt: number;
  sourceHash: string;
  migratedAt: string;
}

export class DocumentLockUnavailableError extends Error {}

export class DocumentStorageGenerationChangedError extends Error {
  constructor(stageId: string) {
    super(
      `Document ${JSON.stringify(stageId)} was not saved because storage was cleared during the mutation`,
    );
    this.name = 'DocumentStorageGenerationChangedError';
  }
}

const MARKER_PREFIX = 'document-migration:';
let defaultKv: KVStore | undefined;
const log = createLogger('DocumentMigration');

/**
 * Run the legacy asset-reference converter over a loaded document. Conversion
 * is best-effort on the load path: a failure (pool unavailable, IndexedDB
 * hiccup) must not break opening the document, so it logs and returns the
 * document unconverted -- legacy references still resolve through the read
 * fallbacks, and the next open retries.
 */
async function convertLoadedDocument(
  document: AppDocument,
  deps: DocumentMigrationDeps,
  ledger?: string[],
): Promise<AppDocument> {
  try {
    const convert =
      deps.convertAssetRefs ??
      (async (value: AppDocument) => {
        const { convertDocumentAssetRefs } = await import('@/lib/media/convert-legacy-asset-refs');
        const converted = await convertDocumentAssetRefs(value, undefined, undefined, ledger);
        // The inline base64 image converter (#1153 part 4) runs AFTER the
        // legacy converter: the two are independent, and this order lets the
        // gen-placeholder converter see its expected shapes first. A failure
        // here degrades to the legacy-converted document rather than
        // discarding the legacy pass's work — each converter is best-effort
        // on its own.
        try {
          const { convertInlineImageAssets } =
            await import('@/lib/media/convert-inline-image-assets');
          return (await convertInlineImageAssets(converted.document, undefined, undefined, ledger))
            .document;
        } catch (inlineError) {
          log.warn(
            `Inline image conversion failed for document ${JSON.stringify(value.stage.id)}; ` +
              'keeping the legacy-converted document',
            inlineError,
          );
          return converted.document;
        }
      });
    return await convert(document, ledger);
  } catch (error) {
    log.warn(
      `Legacy asset conversion failed for document ${JSON.stringify(document.stage.id)}; ` +
        'leaving legacy references for a later open',
      error,
    );
    return document;
  }
}

/**
 * Persist a converted document, fenced by the storage generation exactly like
 * the legacy-migration save below: a conversion write that lands after a
 * clearDatabase would resurrect a document the user asked to wipe, so the
 * write fails loud instead. A no-op conversion (identity) pays no write. The
 * caller's allocation ledger is shared with the reconciliation pass: assets
 * the re-conversion allocates for a concurrent edit must be rolled back if
 * that save fails, exactly like the pass's own allocations. A failed save-back
 * rolls the whole ledger and returns the unconverted document -- the
 * authoritative reloaded document when a concurrent edit was observed, so the
 * caller never sees a stale pre-concurrency snapshot: durable storage still
 * holds the legacy references, so the fresh allocations are orphans, and
 * returning them would let repeated opens accumulate quota.
 */
async function saveConvertedDocument(
  store: DocumentStore<AppScene, AppStage>,
  stageId: string,
  existing: AppDocument,
  converted: AppDocument,
  deps: DocumentMigrationDeps,
  expectedGeneration: number,
  ledger?: string[],
): Promise<AppDocument | null> {
  if (converted === existing) return existing;
  // The authoritative reload observed before a failed save-back: the caller
  // must see the concurrent edit, not the stale pre-concurrency snapshot.
  let reloaded: AppDocument | undefined;
  try {
    // The generation fence sits INSIDE the compensation scope: a cross-realm
    // clearDatabase landing between the fence read and the save strands the
    // pass's fresh allocations, and every exit -- including the fatal fence
    // error -- must roll the ledger back. The fence error itself stays fatal
    // (a cross-tab write race, not a persistence hiccup); it rolls back and
    // rethrows rather than degrading to the unconverted document.
    if ((await readGeneration(deps.kv)) !== expectedGeneration) {
      throw new DocumentStorageGenerationChangedError(stageId);
    }
    // Conversion may have spent seconds probing legacy URLs, and the document
    // lock does not coordinate independent browsers: another client can have
    // written while we converted. Reload and reconcile instead of blindly
    // overwriting -- a fresh read that differs from what we converted gets
    // its own conversion pass, and that is what we save.
    const latest = await store.loadDocument(stageId);
    if (!latest) {
      // The document was deleted while conversion ran. That is a concurrent
      // deletion, not a save target: saving the stale snapshot would recreate
      // the wiped document. The caller's cleanup rolls the conversion's side
      // effects back.
      return null;
    }
    reloaded = latest;
    if (
      !isEqual(
        omitUndefinedObjectMembers(stripDocument(latest)),
        omitUndefinedObjectMembers(stripDocument(existing)),
      )
    ) {
      const reConverted = await convertLoadedDocument(latest, deps, ledger);
      await store.saveDocument(reConverted);
      return reConverted;
    }
    await store.saveDocument(converted);
    return converted;
  } catch (error) {
    if (error instanceof DocumentStorageGenerationChangedError) {
      // A cross-tab clear raced the save: nothing was persisted, so every
      // fresh allocation the pass made is an orphan. Roll them all back
      // before the fatal error surfaces.
      if (ledger && ledger.length > 0) {
        const { rollbackConvertedAllocations } =
          await import('@/lib/media/convert-legacy-asset-refs');
        await rollbackConvertedAllocations(stageId, ledger);
      }
      throw error;
    }
    // Best-effort: a readable document must not fail to open because the
    // save-back did (quota pressure, a transient write error). The write
    // never landed, so durable storage still holds the legacy references:
    // act as if conversion never happened -- roll the pass's allocations
    // back here and return the unconverted document, so the next open
    // retries both cleanly. Returning the converted document would keep its
    // ledger allocations alive while storage still names the legacy refs,
    // and repeated opens could accumulate additional orphaned assets. When
    // the failure followed a reconciliation reload, return the authoritative
    // reloaded document rather than the stale pre-concurrency snapshot: the
    // concurrent edit is durable and must not be hidden from the caller.
    log.warn(
      `Converted document ${JSON.stringify(stageId)} could not be saved back; ` +
        'rolling back its allocations and retrying on the next open',
      error,
    );
    if (ledger && ledger.length > 0) {
      const { rollbackConvertedAllocations } =
        await import('@/lib/media/convert-legacy-asset-refs');
      await rollbackConvertedAllocations(stageId, ledger);
    }
    return reloaded ?? existing;
  }
}

function resolveStore(deps: DocumentMigrationDeps): DocumentStore<AppScene, AppStage> {
  return deps.store ? getDocumentStore({ store: deps.store }) : getDocumentStore();
}

function resolveKv(deps: DocumentMigrationDeps): KVStore {
  if (deps.kv) return deps.kv;
  if (typeof localStorage === 'undefined')
    throw new Error('Document migration KV requires localStorage (client-only)');
  return (defaultKv ??= new BrowserKVStore());
}

function resolveLocks(deps: DocumentMigrationDeps): LockManager | undefined {
  if (deps.lockManager === null) return undefined;
  return deps.lockManager ?? (typeof navigator !== 'undefined' ? navigator.locks : undefined);
}

export function documentLockName(stageId: string): string {
  return `openmaic:document:${encodeURIComponent(stageId)}`;
}

/** Cross-realm serialization for migration and aggregate read-modify-write. */
export async function withDocumentLock<T>(
  stageId: string,
  work: () => Promise<T>,
  deps: Pick<DocumentMigrationDeps, 'lockManager'> = {},
): Promise<T> {
  const locks = resolveLocks(deps);
  if (locks) {
    return await locks.request(documentLockName(stageId), { mode: 'exclusive' }, async () =>
      work(),
    );
  }
  throw new DocumentLockUnavailableError(
    `Web Locks are required to mutate document ${JSON.stringify(stageId)}`,
  );
}

function defaultLegacyStore(): LegacyDocumentStore {
  return {
    async read(stageId) {
      // Dexie disables auto-open after db.delete(). A migration that was
      // queued behind clearDatabase must reopen the now-empty legacy database
      // so it observes a missing source instead of surfacing DatabaseClosedError.
      if (!db.isOpen()) await db.open();
      return db.transaction('r', [db.stages, db.scenes, db.stageOutlines], async () => {
        const [stage, scenes, outline] = await Promise.all([
          db.stages.get(stageId),
          db.scenes.where('stageId').equals(stageId).sortBy('order'),
          db.stageOutlines.get(stageId),
        ]);
        return stage ? { stage, scenes, outline } : null;
      });
    },
    async listStages() {
      if (!db.isOpen()) await db.open();
      return db.stages.toArray();
    },
  };
}

export function getLegacyDocumentStore(
  deps: Pick<DocumentMigrationDeps, 'legacyStore'> = {},
): LegacyDocumentStore {
  return deps.legacyStore ?? defaultLegacyStore();
}

function canonicalize(snapshot: LegacyDocumentSnapshot): AppDocument {
  const { stage } = canonicalizeLegacyStage(snapshot.stage);
  const scenes = snapshot.scenes.map(canonicalizeLegacyScene).sort((a, b) => a.order - b.order);
  const document: AppDocument = { stage, scenes };
  if (snapshot.outline) document.outline = canonicalizeLegacyOutline(snapshot.outline);
  return document;
}

function assertValidDestination(stageId: string, document: AppDocument): void {
  if (document.dslVersion !== DSL_VERSION) {
    throw new Error(
      `Document ${JSON.stringify(stageId)} has unsupported DSL version ${JSON.stringify(document.dslVersion)}`,
    );
  }
  if (document.stage.id !== stageId)
    throw new Error(`Document ${JSON.stringify(stageId)} has a mismatched stage id`);
  const stageValidation = validateAppStage(document.stage);
  if (!stageValidation.valid)
    throw new Error(`Document ${JSON.stringify(stageId)} has an invalid stage`);
  const ids = new Set<string>();
  for (const scene of document.scenes) {
    const validation = validateAppScene(scene);
    if (!validation.valid || scene.stageId !== stageId || ids.has(scene.id)) {
      throw new Error(
        `Document ${JSON.stringify(stageId)} has an invalid scene ${JSON.stringify(scene.id)}`,
      );
    }
    ids.add(scene.id);
  }
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
 * This mirrors `@openmaic/storage`'s private `migrateDocument` in
 * `document/browser.ts`; changes must be kept in sync.
 */
export function migrateDocumentForVerification(
  document: AppDocument,
  migrateDsl: (document: unknown) => unknown = migrate,
): AppDocument {
  const { outline, ...core } = document;
  const migrated = migrateDsl(core) as AppDocument;
  return outline === undefined ? migrated : { ...migrated, outline };
}

/** The comparable projection of a document: scenes order-independent, envelope fields aside. */
function stripDocument(document: AppDocument): unknown {
  return {
    stage: document.stage,
    scenes: [...document.scenes].sort((a, b) => a.order - b.order),
    outline: document.outline,
  };
}

function assertMigrationVerified(
  expected: AppDocument,
  actual: AppDocument,
  migrateDsl: (document: unknown) => unknown = migrate,
): void {
  assertValidDestination(expected.stage.id, actual);
  const migratedExpected = migrateDocumentForVerification(expected, migrateDsl);
  if (
    !isEqual(
      omitUndefinedObjectMembers(stripDocument(actual)),
      omitUndefinedObjectMembers(stripDocument(migratedExpected)),
    )
  ) {
    throw new Error(
      `Legacy migration verification failed for document ${JSON.stringify(expected.stage.id)}`,
    );
  }
}

function sourceHash(snapshot: LegacyDocumentSnapshot): string {
  const text = JSON.stringify(snapshot);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function migrateCurrentScene(snapshot: LegacyDocumentSnapshot, kv: KVStore): Promise<void> {
  if (!snapshot.stage.currentSceneId) return;
  const existing = await loadCurrentSceneValue(snapshot.stage.id, kv);
  const sourceTime = snapshot.stage.updatedAt;
  if (existing && Date.parse(existing.updatedAt) > sourceTime) return;
  const value: CurrentSceneValue = {
    sceneId: snapshot.stage.currentSceneId,
    updatedAt: new Date(sourceTime).toISOString(),
  };
  await saveCurrentSceneValue(snapshot.stage.id, value, kv);
}

async function finishMigrationMetadata(
  snapshot: LegacyDocumentSnapshot,
  kv: KVStore,
): Promise<void> {
  const markerKey = `${MARKER_PREFIX}${snapshot.stage.id}`;
  if (await kv.get<MigrationMarker>(markerKey, 'device')) return;
  await migrateCurrentScene(snapshot, kv);
  const marker: MigrationMarker = {
    sourceUpdatedAt: snapshot.stage.updatedAt,
    sourceHash: sourceHash(snapshot),
    migratedAt: new Date().toISOString(),
  };
  await kv.set(markerKey, marker, 'device');
}

async function migrateLocked(
  stageId: string,
  deps: DocumentMigrationDeps,
): Promise<DocumentAccessResult> {
  // Lock order: the per-stage document lock is acquired by the caller before
  // the global shared epoch. This matches the established per-stage -> global
  // order and prevents clearDatabase from interleaving with migration commit.
  const store = resolveStore(deps);

  // Phase 1, shared lock: the reads. They are cheap, and they must be inside
  // the lock because clearDatabase bumps the generation before it deletes,
  // so a read outside the lock can observe content whose epoch already moved
  // and match the fence anyway.
  const probe = await withRuntimeStorageSharedLock(async () => {
    let existing: AppDocument | null = null;
    let snapshot: LegacyDocumentSnapshot | null = null;
    try {
      existing = await store.loadDocument(stageId);
      if (existing) assertValidDestination(stageId, existing);
      snapshot = await getLegacyDocumentStore(deps).read(stageId);
    } catch (error) {
      // A clear that landed mid-read closes the database out from under it.
      // The phase-3 fence redoes the reads inside the lock.
      if (!(error instanceof Error && error.name === 'DatabaseClosedError')) throw error;
      return null;
    }
    // finishMigrationMetadata runs when the marker already exists or the
    // snapshot verifies; a diverged snapshot skips it, so the destination is
    // converted and persisted exactly like the main exit and diverged
    // documents are not stranded with legacy references forever.
    let metadataPending = false;
    if (existing && snapshot) {
      const kv = resolveKv(deps);
      const markerKey = `${MARKER_PREFIX}${stageId}`;
      if (await kv.get<MigrationMarker>(markerKey, 'device')) {
        metadataPending = true;
      } else {
        try {
          assertMigrationVerified(canonicalize(snapshot), existing, deps.migrateDsl);
          metadataPending = true;
        } catch (error) {
          log.warn(
            `Legacy snapshot diverges from authoritative destination for stage ${stageId}; migration marker was not written`,
            error,
          );
        }
      }
    }
    return {
      existing,
      snapshot,
      metadataPending,
      generation: await readGeneration(deps.kv),
    };
  });

  if (probe !== null && probe.existing === null && probe.snapshot === null) {
    return { document: null, readOnlyLegacy: false };
  }

  // Phase 2, no lock: the expensive part. URL probing can consume the full
  // aggregate budget, and a shared lock held that long fails clearDatabase's
  // five-second exclusive acquisition on an unrelated slow URL. Every pass
  // shares one ledger so a discarded or superseded result still owns its
  // side effects.
  const passLedger: string[] = [];
  const converted = probe?.existing
    ? await convertLoadedDocument(probe.existing, deps, passLedger)
    : null;
  // The birth path converts the canonicalized legacy aggregate before it is
  // first saved, so the destination is born with allocated asset ids where
  // bytes are available. The verification migrates `expected` through the
  // pure ladder before comparing, so a kept co-present pair (which the
  // ladder preserves) verifies consistently.
  const expected =
    probe && !probe.existing && probe.snapshot
      ? await convertLoadedDocument(canonicalize(probe.snapshot), deps, passLedger)
      : null;

  // Phase 3, shared lock: fence, reconcile, commit.
  return withRuntimeStorageSharedLock(async () => {
    // Every exit rolls back the ledger entries the returned document does
    // not reference: a null answer (a concurrent deletion, an epoch change)
    // releases them all, and a reconciled or redone document keeps exactly
    // what it uses. The full document ref set is the reference space, NOT
    // just the renderable `referenced` set: a ref that appears only as a
    // videoManifest key is still owned by the persisted manifest, and
    // rolling its allocation back would leave the manifest naming an id
    // whose bytes are gone.
    const cleanup = async (finalDoc: AppDocument | null): Promise<void> => {
      if (passLedger.length === 0) return;
      const { rollbackConvertedAllocations } =
        await import('@/lib/media/convert-legacy-asset-refs');
      if (!finalDoc) {
        await rollbackConvertedAllocations(stageId, passLedger);
        return;
      }
      const documentRefs = collectStageAssetRefs(finalDoc, {
        mediaRows: [],
        audioRows: [],
      }).document;
      const orphans = passLedger.filter((id) => !documentRefs.has(id));
      await rollbackConvertedAllocations(stageId, orphans);
    };

    const currentGeneration = await readGeneration(deps.kv);
    if (probe === null || currentGeneration !== probe.generation) {
      // The probe raced an epoch change (or never read at all): redo the
      // reads inside the lock and answer from what is actually there. This
      // path converts under the lock, which is slow only in the rare case it
      // exists for.
      const current = await store.loadDocument(stageId);
      if (current) {
        assertValidDestination(stageId, current);
        const fresh = await convertLoadedDocument(current, deps, passLedger);
        const settled = await saveConvertedDocument(
          store,
          stageId,
          current,
          fresh,
          deps,
          currentGeneration,
          passLedger,
        );
        await cleanup(settled);
        return { document: settled, readOnlyLegacy: false };
      }
      const freshSnapshot = await getLegacyDocumentStore(deps).read(stageId);
      if (!freshSnapshot) {
        await cleanup(null);
        return { document: null, readOnlyLegacy: false };
      }
      const freshExpected = await convertLoadedDocument(
        canonicalize(freshSnapshot),
        deps,
        passLedger,
      );
      try {
        await store.saveDocument(freshExpected);
      } catch (error) {
        // A failed first save leaves the pass's side effects unattached;
        // roll them back before the error surfaces.
        await cleanup(null);
        throw error;
      }
      const actual = await store.loadDocument(stageId);
      if (!actual) {
        // The document was saved but vanished before the reload could see it
        // (a concurrent deletion landing between the two): the pass's fresh
        // allocations are now unowned, so roll them back before surfacing
        // the loss.
        await cleanup(null);
        throw new Error(`Legacy migration lost document ${JSON.stringify(stageId)}`);
      }
      assertMigrationVerified(freshExpected, actual, deps.migrateDsl);
      await finishMigrationMetadata(freshSnapshot, resolveKv(deps));
      await cleanup(actual);
      return { document: actual, readOnlyLegacy: false };
    }

    if (probe.existing && converted) {
      if (probe.snapshot && probe.metadataPending) {
        await finishMigrationMetadata(probe.snapshot, resolveKv(deps));
      }
      const settled = await saveConvertedDocument(
        store,
        stageId,
        probe.existing,
        converted,
        deps,
        probe.generation,
        passLedger,
      );
      await cleanup(settled);
      return { document: settled, readOnlyLegacy: false };
    }

    if (!probe.snapshot || !expected) {
      await cleanup(null);
      return { document: null, readOnlyLegacy: false };
    }
    try {
      await store.saveDocument(expected);
    } catch (error) {
      // A failed first save leaves the pass's side effects unattached;
      // roll them back before the error surfaces.
      await cleanup(null);
      throw error;
    }
    const actual = await store.loadDocument(stageId);
    if (!actual) {
      // The document was saved but vanished before the reload could see it
      // (a concurrent deletion landing between the two): the pass's fresh
      // allocations are now unowned, so roll them back before surfacing the
      // loss.
      await cleanup(null);
      throw new Error(`Legacy migration lost document ${JSON.stringify(stageId)}`);
    }
    assertMigrationVerified(expected, actual, deps.migrateDsl);
    await finishMigrationMetadata(probe.snapshot, resolveKv(deps));
    await cleanup(actual);
    return { document: actual, readOnlyLegacy: false };
  });
}

function generationGuardedStore(
  stageId: string,
  expectedGeneration: number,
  deps: DocumentMigrationDeps,
): DocumentStore<AppScene, AppStage> {
  const store = resolveStore(deps);
  // Every mutating method takes the fence, not just saveDocument: the others
  // are not currently exploitable after a clear (puts throw on the missing
  // parent, deletes are idempotent), but that safety is incidental — a future
  // store method or semantic change must not silently bypass the fence.
  const MUTATING_METHODS = new Set([
    'saveDocument',
    'putStage',
    'putScene',
    'deleteScene',
    'deleteDocument',
  ]);
  return new Proxy(store, {
    get(target, property) {
      if (typeof property === 'string' && MUTATING_METHODS.has(property)) {
        const method = Reflect.get(target, property, target) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        const guarded = async (...args: unknown[]): Promise<unknown> => {
          if ((await readGeneration(deps.kv)) !== expectedGeneration) {
            throw new DocumentStorageGenerationChangedError(stageId);
          }
          return method.apply(target, args);
        };
        return deps.storageSharedLockHeld
          ? guarded
          : (...args: unknown[]) => withRuntimeStorageSharedLock(() => guarded(...args));
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Load the authoritative destination, lazily migrating one coherent legacy snapshot. */
export async function accessDocument(
  stageId: string,
  deps: DocumentMigrationDeps = {},
): Promise<DocumentAccessResult> {
  try {
    return await withDocumentLock(stageId, async () => migrateLocked(stageId, deps), deps);
  } catch (error) {
    if (!(error instanceof DocumentLockUnavailableError)) throw error;
    // Reference conversion is deliberately skipped on the lock-free fallback:
    // allocating assets and saving the rewrite without cross-realm exclusion
    // could double-allocate against a peer realm. Legacy references still
    // resolve through the read fallbacks, and a later locked open converts.
    const destination = await resolveStore(deps).loadDocument(stageId);
    if (destination) {
      assertValidDestination(stageId, destination);
      return { document: destination, readOnlyLegacy: false };
    }
    const snapshot = await getLegacyDocumentStore(deps).read(stageId);
    if (!snapshot) return { document: null, readOnlyLegacy: false };
    return {
      document: canonicalize(snapshot),
      legacyCurrentSceneId: snapshot.stage.currentSceneId,
      readOnlyLegacy: true,
    };
  }
}

/** Aggregate mutation entry point; migration and the caller's RMW share one lock. */
export function mutateDocument<T>(
  stageId: string,
  work: (document: AppDocument | null, store: DocumentStore<AppScene, AppStage>) => Promise<T>,
  deps: DocumentMigrationDeps = {},
  options: DocumentMutationOptions = {},
): Promise<T> {
  const entryGeneration = readGeneration(deps.kv);
  const mutateLocked = async (): Promise<T> => {
    const expectedGeneration = await entryGeneration;
    // A wholesale replacement never needs the current aggregate: eager
    // conversion would allocate assets for content the callback immediately
    // replaces, orphaning them. The callback writes the replacement itself.
    const document =
      options.mode === 'replace' ? null : (await migrateLocked(stageId, deps)).document;
    return work(document, generationGuardedStore(stageId, expectedGeneration, deps));
  };
  return withDocumentLock(stageId, mutateLocked, deps).catch(async (error: unknown) => {
    if (!(error instanceof DocumentLockUnavailableError)) throw error;
    // DocumentLockUnavailableError is raised only when the Web Locks API is
    // ABSENT (a non-secure context, an older browser, some webviews): a lock
    // manager that exists but fails to acquire rejects with its own error,
    // which the guard above rethrows -- that is the race requireLock exists
    // to prevent, and it keeps failing. An absent API degrades to the app's
    // established lock-free route even for callers that normally require the
    // lock: the alternative is a silent no-op cold load (the server fallback
    // returning null where it used to load), and the rest of the app already
    // accepts the lock-free risk profile for destination-backed and new
    // documents. The degraded pass keeps the caller's ledger+rollback
    // discipline, so a failed unlocked attempt still leaves nothing behind.

    // Migration is never attempted without cross-realm exclusion. A
    // destination-backed document (or a genuinely new id) can still accept
    // the product's established lock-free/LWW risk; a legacy-only document
    // stays read-only so two authorities cannot fork.
    const expectedGeneration = await entryGeneration;
    if (options.mode === 'replace') {
      return work(null, generationGuardedStore(stageId, expectedGeneration, deps));
    }
    const store = resolveStore(deps);
    const destination = await store.loadDocument(stageId);
    if (destination) {
      assertValidDestination(stageId, destination);
      return work(destination, generationGuardedStore(stageId, expectedGeneration, deps));
    }
    if (await getLegacyDocumentStore(deps).read(stageId)) throw error;
    return work(null, generationGuardedStore(stageId, expectedGeneration, deps));
  });
}

export type { AppDocumentOutline };
