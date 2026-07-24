import { DSL_VERSION } from '@openmaic/dsl';
import { BrowserKVStore, type DocumentStore, type KVStore } from '@openmaic/storage';
import isEqual from 'lodash/isEqual';

import type { AppScene } from '@/lib/types/stage';
import { createLogger } from '@/lib/logger';
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
  /** The mutation callback acquires the runtime shared epoch before writing. */
  storageSharedLockHeld?: boolean;
}

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

function resolveStore(deps: DocumentMigrationDeps): DocumentStore<AppScene, AppStage> {
  return deps.store ?? getDocumentStore();
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

function assertMigrationVerified(expected: AppDocument, actual: AppDocument): void {
  assertValidDestination(expected.stage.id, actual);
  const strip = (document: AppDocument) => ({
    stage: document.stage,
    scenes: [...document.scenes].sort((a, b) => a.order - b.order),
    outline: document.outline,
  });
  if (!isEqual(strip(actual), strip(expected))) {
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
  expectedGeneration: number,
): Promise<DocumentAccessResult> {
  // Lock order: the per-stage document lock is acquired by the caller before
  // this global shared epoch. This matches the established per-stage -> global
  // order and prevents clearDatabase from interleaving with migration commit.
  return withRuntimeStorageSharedLock(async () => {
    const store = resolveStore(deps);
    const existing = await store.loadDocument(stageId);
    if (existing) {
      assertValidDestination(stageId, existing);
      const snapshot = await getLegacyDocumentStore(deps).read(stageId);
      if (snapshot) {
        const kv = resolveKv(deps);
        const markerKey = `${MARKER_PREFIX}${stageId}`;
        if (!(await kv.get<MigrationMarker>(markerKey, 'device'))) {
          try {
            assertMigrationVerified(canonicalize(snapshot), existing);
          } catch (error) {
            log.warn(
              `Legacy snapshot diverges from authoritative destination for stage ${stageId}; migration marker was not written`,
              error,
            );
            return { document: existing, readOnlyLegacy: false };
          }
        }
        await finishMigrationMetadata(snapshot, kv);
      }
      return { document: existing, readOnlyLegacy: false };
    }

    const snapshot = await getLegacyDocumentStore(deps).read(stageId);
    if (!snapshot) return { document: null, readOnlyLegacy: false };
    const expected = canonicalize(snapshot);
    if ((await readGeneration(deps.kv)) !== expectedGeneration) {
      throw new DocumentStorageGenerationChangedError(stageId);
    }
    await store.saveDocument(expected);
    const actual = await store.loadDocument(stageId);
    if (!actual) throw new Error(`Legacy migration lost document ${JSON.stringify(stageId)}`);
    assertMigrationVerified(expected, actual);

    await finishMigrationMetadata(snapshot, resolveKv(deps));
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
    return await withDocumentLock(
      stageId,
      async () => migrateLocked(stageId, deps, await readGeneration(deps.kv)),
      deps,
    );
  } catch (error) {
    if (!(error instanceof DocumentLockUnavailableError)) throw error;
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
): Promise<T> {
  const entryGeneration = readGeneration(deps.kv);
  const mutateLocked = async (): Promise<T> => {
    const expectedGeneration = await entryGeneration;
    const access = await migrateLocked(stageId, deps, expectedGeneration);
    return work(access.document, generationGuardedStore(stageId, expectedGeneration, deps));
  };
  return withDocumentLock(stageId, mutateLocked, deps).catch(async (error: unknown) => {
    if (!(error instanceof DocumentLockUnavailableError)) throw error;

    // Migration is never attempted without cross-realm exclusion. A
    // destination-backed document (or a genuinely new id) can still accept
    // the product's established lock-free/LWW risk; a legacy-only document
    // stays read-only so two authorities cannot fork.
    const store = resolveStore(deps);
    const destination = await store.loadDocument(stageId);
    if (destination) {
      assertValidDestination(stageId, destination);
      const expectedGeneration = await entryGeneration;
      return work(destination, generationGuardedStore(stageId, expectedGeneration, deps));
    }
    if (await getLegacyDocumentStore(deps).read(stageId)) throw error;
    const expectedGeneration = await entryGeneration;
    return work(null, generationGuardedStore(stageId, expectedGeneration, deps));
  });
}

export type { AppDocumentOutline };
