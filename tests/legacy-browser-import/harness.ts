/**
 * Test harness for the one-way legacy browser importer.
 *
 * - `FakeServer`: an in-memory, owner-aware stand-in for the server behind the
 *   app's persistence seams. Documents and runtime go through the package's
 *   validating stores (over an isolated fake-indexeddb factory) and are
 *   wrapped with the server's ownership answers: ids are global, reads by id
 *   are open, writes to another owner's course answer 403, writes to a course
 *   this owner deleted answer 404, runtime is partitioned by learner key.
 *   Assets are a map with an optional per-owner quota. Every operation can be
 *   made to fail through `failWith`.
 * - Seeders for the four legacy databases, in the shapes earlier builds wrote.
 * - `dumpLegacyDatabases`: every legacy database, store by store and row by
 *   row (Blobs by content), to prove the importer writes nothing there.
 */
import 'fake-indexeddb/auto';

import { createHash } from 'node:crypto';

import type { RuntimeRecordInit, RuntimeSession } from '@openmaic/dsl';
import {
  BrowserAssetStore,
  BrowserDocumentStore,
  BrowserRuntimeStore,
  HttpDocumentStoreError,
  type DocumentStore,
  type RuntimeStore,
  type RuntimeSessionInit,
} from '@openmaic/storage';
import { HttpAssetStoreError } from '@openmaic/storage';
import { HttpRuntimeStoreError } from '@openmaic/storage/runtime/http';
import Dexie from 'dexie';
import { IDBFactory } from 'fake-indexeddb';

import type { AppDocument, AppStage } from '@/lib/document-store/persistence-types';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { AssetPoolStore } from '@/lib/media/asset-pool-config';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import type { FolderRecord } from '@/lib/types/folder';
import type { AppScene } from '@/lib/types/stage';
import { FolderNameError } from '@/lib/utils/folder-name-validation';

export const OWNER_A = 'anon:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const OWNER_B = 'anon:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const LEGACY_LEARNER = 'anon:legacy-device-0000';
export const NOW = 1_780_000_000_000;
export const ISO = new Date(NOW).toISOString();

export const LEGACY_NAMES = ['MAIC-Database', 'maic-documents', 'maic-runtime', 'maic-asset-pool'];

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  clear(): void {
    this.values.clear();
  }
}

// ---------------------------------------------------------------------------
// The fake server
// ---------------------------------------------------------------------------

export type FailHook = (operation: string, subject: string) => unknown;

export class FakeServer {
  owner = OWNER_A;
  readonly calls: string[] = [];
  /** Return an error to make `operation` on `subject` throw it. */
  failWith: FailHook = () => undefined;
  /** Per-owner asset quota in bytes. */
  quotaBytes = Number.POSITIVE_INFINITY;

  private readonly idb = new IDBFactory();
  private readonly docs = new BrowserDocumentStore<AppScene, AppStage>({
    indexedDB: this.idb,
    dbName: 'fake-server-documents',
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
  private readonly runtimeInner = new BrowserRuntimeStore({
    indexedDB: this.idb,
    dbName: 'fake-server-runtime',
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  readonly stageOwners = new Map<string, string>();
  readonly deleted = new Set<string>();
  readonly assets = new Map<string, { owner: string; blob: Blob; contentType?: string }>();
  readonly folders = new Map<string, FolderRecord[]>();
  readonly membership = new Map<string, string>();
  private assetCounter = 0;
  private folderCounter = 0;

  private check(operation: string, subject: string): void {
    this.calls.push(`${operation} ${subject}`);
    const error = this.failWith(operation, subject);
    if (error) throw error;
  }

  private writable(stageId: string): void {
    const owner = this.stageOwners.get(stageId);
    if (owner === undefined) {
      throw new HttpDocumentStoreError(404, 'DOCUMENT_NOT_FOUND', 'document not found');
    }
    if (owner !== this.owner) throw new HttpDocumentStoreError(403, 'FORBIDDEN', 'forbidden');
    if (this.deleted.has(stageId)) {
      throw new HttpDocumentStoreError(404, 'DOCUMENT_NOT_FOUND', 'document not found');
    }
  }

  /** Seed a course as `owner` wrote it (bypassing the importer). */
  async seedDocument(document: AppDocument, owner = this.owner): Promise<void> {
    await this.docs.saveDocument(structuredClone(document));
    this.stageOwners.set(document.stage.id, owner);
  }

  async rawDocument(stageId: string): Promise<AppDocument | null> {
    return this.docs.loadDocument(stageId);
  }

  readonly documents: DocumentStore<AppScene, AppStage> = {
    loadDocument: async (stageId) => {
      this.check('loadDocument', stageId);
      if (this.deleted.has(stageId)) return null;
      return this.docs.loadDocument(stageId);
    },
    saveDocument: async (document) => {
      const stageId = document.stage.id;
      this.check('saveDocument', stageId);
      const owner = this.stageOwners.get(stageId);
      if (owner !== undefined && owner !== this.owner) {
        throw new HttpDocumentStoreError(403, 'FORBIDDEN', 'forbidden');
      }
      if (owner !== undefined && this.deleted.has(stageId)) {
        throw new HttpDocumentStoreError(404, 'DOCUMENT_NOT_FOUND', 'document not found');
      }
      await this.docs.saveDocument(document);
      this.stageOwners.set(stageId, this.owner);
    },
    listDocuments: async () => {
      throw new HttpDocumentStoreError(403, 'FORBIDDEN_DOCUMENTS', 'listing is refused');
    },
    deleteDocument: async (stageId) => {
      this.check('deleteDocument', stageId);
      this.writable(stageId);
      this.deleted.add(stageId);
    },
    putStage: async (stageId, stage) => {
      this.check('putStage', stageId);
      this.writable(stageId);
      await this.docs.putStage(stageId, stage);
    },
    putScene: async (stageId, scene) => {
      this.check('putScene', stageId);
      this.writable(stageId);
      await this.docs.putScene(stageId, scene);
    },
    getScene: async (stageId, sceneId) => this.docs.getScene(stageId, sceneId),
    deleteScene: async (stageId, sceneId) => {
      this.check('deleteScene', stageId);
      this.writable(stageId);
      await this.docs.deleteScene(stageId, sceneId);
    },
  } as DocumentStore<AppScene, AppStage>;

  private ownSession(session: RuntimeSession | undefined): RuntimeSession | undefined {
    return session && session.learnerKey === this.owner ? session : undefined;
  }

  async rawSessions(stageId: string, learnerKey = this.owner): Promise<RuntimeSession[]> {
    return this.runtimeInner.listSessions(stageId, learnerKey);
  }

  async rawRecords(sessionId: string) {
    return this.runtimeInner.listRecords(sessionId);
  }

  async seedSession(
    init: RuntimeSessionInit,
    records: Omit<RuntimeRecordInit, 'sessionId'>[] = [],
  ) {
    const session = await this.runtimeInner.createSession(init);
    for (const record of records) {
      await this.runtimeInner.appendRecord({
        ...record,
        sessionId: session.id,
      } as RuntimeRecordInit);
    }
    return session;
  }

  readonly runtime: RuntimeStore = {
    createSession: async (init) => {
      this.check('createSession', init.id);
      if (init.learnerKey !== this.owner) {
        throw new HttpRuntimeStoreError(403, 'FORBIDDEN_LEARNER', 'forbidden learner');
      }
      try {
        return await this.runtimeInner.createSession(init);
      } catch (error) {
        if ((error as { code?: string }).code === 'SESSION_ALREADY_EXISTS') {
          throw new HttpRuntimeStoreError(409, 'SESSION_ALREADY_EXISTS', 'taken');
        }
        throw error;
      }
    },
    getSession: async (sessionId) => {
      this.check('getSession', sessionId);
      return this.ownSession(await this.runtimeInner.getSession(sessionId));
    },
    listSessions: async (stageId, learnerKey) => {
      this.check('listSessions', stageId);
      if (learnerKey !== this.owner) {
        throw new HttpRuntimeStoreError(403, 'FORBIDDEN_LEARNER', 'forbidden learner');
      }
      return this.runtimeInner.listSessions(stageId, learnerKey);
    },
    listRecords: async (sessionId, opts) => {
      this.check('listRecords', sessionId);
      if (!this.ownSession(await this.runtimeInner.getSession(sessionId))) return [];
      return this.runtimeInner.listRecords(sessionId, opts);
    },
    appendRecord: async (init, options) => {
      this.check('appendRecord', init.sessionId);
      if (!this.ownSession(await this.runtimeInner.getSession(init.sessionId))) {
        throw new HttpRuntimeStoreError(404, 'SESSION_NOT_FOUND', 'no session');
      }
      return this.runtimeInner.appendRecord(init, options);
    },
    setSessionStatus: async (sessionId, status, updatedAt, options) => {
      this.check('setSessionStatus', sessionId);
      if (!this.ownSession(await this.runtimeInner.getSession(sessionId))) {
        throw new HttpRuntimeStoreError(404, 'SESSION_NOT_FOUND', 'no session');
      }
      return this.runtimeInner.setSessionStatus(sessionId, status, updatedAt, options);
    },
    deleteSession: async (sessionId) => {
      this.check('deleteSession', sessionId);
      if (!this.ownSession(await this.runtimeInner.getSession(sessionId))) return;
      return this.runtimeInner.deleteSession(sessionId);
    },
    mergeLearner: async () => 0,
    deleteLearnerRuntime: async () => undefined,
    deleteStageRuntime: async () => undefined,
    deleteAllRuntime: async () => undefined,
  };

  private usedBytes(owner: string): number {
    let used = 0;
    for (const entry of this.assets.values()) if (entry.owner === owner) used += entry.blob.size;
    return used;
  }

  readonly assetPool: AssetPoolStore = {
    put: async (data, meta) => {
      const blob = data as Blob;
      this.check('putAsset', String(blob.size));
      if (this.usedBytes(this.owner) + blob.size > this.quotaBytes) {
        throw new HttpAssetStoreError(507, 'ASSET_QUOTA_EXCEEDED', 'no room');
      }
      this.assetCounter += 1;
      const id = `ast_server${String(this.assetCounter).padStart(4, '0')}`;
      this.assets.set(id, {
        owner: this.owner,
        blob,
        ...(meta?.contentType ? { contentType: meta.contentType } : {}),
      });
      return id;
    },
    resolve: async (ref) => {
      const entry = this.assets.get(ref);
      return entry ? URL.createObjectURL(entry.blob) : null;
    },
    exists: async (ref) => {
      this.check('assetExists', ref);
      return this.assets.has(ref);
    },
    invalidate: async () => undefined,
    remove: async () => undefined,
    release: async () => undefined,
    close: async () => undefined,
  };

  listOwnedStages = async () => {
    this.check('listOwnedStages', this.owner);
    return [...this.stageOwners.entries()]
      .filter(([id, owner]) => owner === this.owner && !this.deleted.has(id))
      .map(([id]) => ({
        id,
        ...(this.membership.has(id) ? { folderId: this.membership.get(id)! } : {}),
      }));
  };

  ownerId = async () => {
    this.check('ownerId', '');
    return this.owner;
  };

  folderLimit = Number.POSITIVE_INFINITY;

  readonly folderApi = {
    list: async (): Promise<FolderRecord[]> => {
      this.check('listFolders', this.owner);
      return structuredClone(this.folders.get(this.owner) ?? []);
    },
    create: async (name: string): Promise<FolderRecord> => {
      this.check('createFolder', name);
      const mine = this.folders.get(this.owner) ?? [];
      if (mine.some((folder) => folder.name === name)) {
        throw new FolderNameError('duplicate', 'duplicate');
      }
      if (mine.length >= this.folderLimit) throw new FolderNameError('limit', 'limit');
      this.folderCounter += 1;
      const folder = {
        id: `srv-folder-${this.folderCounter}`,
        name,
        order: mine.length,
        createdAt: NOW,
        updatedAt: NOW,
      };
      this.folders.set(this.owner, [...mine, folder]);
      return structuredClone(folder);
    },
    setMembership: async (stageId: string, folderId: string): Promise<void> => {
      this.check('setMembership', stageId);
      this.writable(stageId);
      if (!(this.folders.get(this.owner) ?? []).some((folder) => folder.id === folderId)) {
        throw new Error(`Folder not found: ${folderId}`);
      }
      this.membership.set(stageId, folderId);
    },
  };

  /**
   * What claiming anonymous owner `from` into `to` does on the server: every
   * course (tombstones included), runtime session, asset and folder moves.
   */
  async claim(from: string, to: string): Promise<void> {
    this.merges.set(from, to);
    for (const [id, owner] of this.stageOwners) if (owner === from) this.stageOwners.set(id, to);
    await this.runtimeInner.mergeLearner(from, to);
    for (const entry of this.assets.values()) if (entry.owner === from) entry.owner = to;
    const moved = this.folders.get(from) ?? [];
    this.folders.set(to, [...(this.folders.get(to) ?? []), ...moved]);
    this.folders.delete(from);
  }

  /** `owner_merges`: retired owner -> the owner it was claimed into. */
  readonly merges = new Map<string, string>();

  /** `GET /api/identity/merged-from` as the server answers it, for the current owner. */
  mergedFrom = async (salt: string, digest: string): Promise<boolean> => {
    this.check('mergedFrom', digest);
    return [...this.merges].some(
      ([from, to]) =>
        to === this.owner &&
        createHash('sha256').update(`${salt}\u0000${from}`).digest('hex') === digest,
    );
  };

  /** The importer options that point it at this server. */
  options(storage: Storage, extra: Record<string, unknown> = {}) {
    return {
      storage,
      locks: null,
      now: () => NOW,
      ownerId: this.ownerId,
      listOwnedStages: this.listOwnedStages,
      folders: this.folderApi,
      mergedFrom: this.mergedFrom,
      log: () => undefined,
      ...extra,
    };
  }
}

/** Point the app's persistence seams at `server`. */
export async function configureSeams(server: FakeServer): Promise<() => Promise<void>> {
  const documentConfig = await import('@/lib/document-store/config');
  const runtimeConfig = await import('@/lib/runtime/config');
  const assetConfig = await import('@/lib/media/asset-pool-config');
  const { clearAssetPool } = await import('@/lib/media/asset-pool');
  documentConfig.resetDocumentStorageForTests();
  runtimeConfig.resetRuntimeStorageForTests();
  assetConfig.resetAssetPoolStorageForTests();
  documentConfig.configureDocumentStorage({ store: server.documents });
  runtimeConfig.configureRuntimeStorage({ store: server.runtime, learnerKey: () => server.owner });
  assetConfig.configureAssetPoolStorage({ store: () => server.assetPool });
  return async () => {
    await clearAssetPool();
    documentConfig.resetDocumentStorageForTests();
    runtimeConfig.resetRuntimeStorageForTests();
    assetConfig.resetAssetPoolStorageForTests();
  };
}

// ---------------------------------------------------------------------------
// Legacy databases
// ---------------------------------------------------------------------------

/**
 * A fresh browser: a new IndexedDB factory for everything opened from now on
 * (the legacy stores keep connections open for the page's life, so deleting
 * their databases would block), and an emptied device cache.
 */
export async function freshBrowser(): Promise<void> {
  const { db } = await import('@/lib/device-storage/database');
  const { resetLegacyBrowserStorageForTests } = await import('@/lib/legacy-browser-storage');
  const factory = new IDBFactory();
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    writable: true,
    value: factory,
  });
  (Dexie.dependencies as { indexedDB: IDBFactory }).indexedDB = factory;
  resetLegacyBrowserStorageForTests();
  // The device cache was constructed on the first factory; empty it there
  // (and let it reopen on the next use, as Clear Local Cache does).
  await db.delete({ disableAutoOpen: false });
}

const THEME = {
  backgroundColor: '#ffffff',
  themeColors: ['#2563eb'],
  fontColor: '#111827',
  fontName: 'Inter',
};

export interface SceneSpec {
  id: string;
  order: number;
  imageRef?: string;
  videoRef?: string;
  posterRef?: string;
  audioIds?: { id: string; audioId: string; text: string }[];
  type?: 'slide' | 'quiz';
}

/** A valid slide scene (canvas with optional image/video elements and speech). */
export function slideScene(stageId: string, spec: SceneSpec): AppScene {
  const elements: unknown[] = [];
  if (spec.imageRef) {
    elements.push({
      id: `${spec.id}-image`,
      type: 'image',
      src: spec.imageRef,
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      fixedRatio: true,
    });
  }
  if (spec.videoRef) {
    elements.push({
      id: `${spec.id}-video`,
      type: 'video',
      src: spec.videoRef,
      ...(spec.posterRef ? { poster: spec.posterRef } : {}),
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      autoplay: false,
    });
  }
  return {
    id: spec.id,
    stageId,
    type: 'slide',
    title: `Scene ${spec.order}`,
    order: spec.order,
    content: {
      type: 'slide',
      canvas: {
        id: `${spec.id}-canvas`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: THEME,
        elements,
      },
    },
    actions: (spec.audioIds ?? []).map((action) => ({
      id: action.id,
      type: 'speech',
      text: action.text,
      audioId: action.audioId,
    })),
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as AppScene;
}

export function course(stageId: string, scenes: SceneSpec[], name = stageId): AppDocument {
  return {
    stage: { id: stageId, name, createdAt: NOW, updatedAt: NOW },
    scenes: scenes.map((spec) => slideScene(stageId, spec)),
    outline: { outlines: [], generationComplete: true, createdAt: NOW, updatedAt: NOW },
  } as AppDocument;
}

function closeStore(store: object): Promise<void> {
  const open = (store as { openDb(): Promise<IDBDatabase> }).openDb.bind(store);
  return open().then((database) => database.close());
}

/** Write documents into the browser document store (`maic-documents`). */
export async function seedDocumentsStore(documents: AppDocument[]): Promise<void> {
  const store = new BrowserDocumentStore<AppScene, AppStage>({
    dbName: 'maic-documents',
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
  for (const document of documents) await store.saveDocument(document);
  await closeStore(store);
}

/** Write runtime sessions into the browser runtime store (`maic-runtime`). */
export async function seedRuntimeStore(
  sessions: {
    init: RuntimeSessionInit;
    records: Omit<RuntimeRecordInit, 'sessionId'>[];
    status?: RuntimeSession['status'];
  }[],
): Promise<void> {
  const store = new BrowserRuntimeStore({
    dbName: 'maic-runtime',
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  for (const { init, records, status } of sessions) {
    await store.createSession(init);
    for (const record of records) {
      await store.appendRecord({ ...record, sessionId: init.id } as RuntimeRecordInit);
    }
    if (status && status !== init.status) await store.setSessionStatus(init.id, status, ISO);
  }
  await closeStore(store);
}

/** Put bytes into the browser asset pool (`maic-asset-pool`); returns their id. */
export async function seedAssetPool(blobs: Blob[]): Promise<string[]> {
  const store = new BrowserAssetStore({ dbName: 'maic-asset-pool' });
  const ids: string[] = [];
  for (const blob of blobs) ids.push(await store.put(blob, { contentType: blob.type }));
  await closeStore(store);
  await store.close();
  return ids;
}

/** Record the device learner key the browser runtime store used. */
export function seedLegacyLearnerKey(storage: Storage, learnerKey = LEGACY_LEARNER): void {
  storage.setItem('maic:device:runtime.learnerKey', JSON.stringify(learnerKey));
}

// ---------------------------------------------------------------------------
// Dumps
// ---------------------------------------------------------------------------

async function serialize(value: unknown): Promise<unknown> {
  if (value instanceof Blob) {
    return { blob: value.type, bytes: Buffer.from(await value.arrayBuffer()).toString('base64') };
  }
  if (value instanceof ArrayBuffer) {
    return { arrayBuffer: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return Promise.all(value.map(serialize));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, inner]) => [key, await serialize(inner)] as const),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Every row of every legacy database (and each database's version and stores). */
export async function dumpLegacyDatabases(): Promise<unknown> {
  const dump: Record<string, unknown> = {};
  const existing = new Set((await indexedDB.databases()).map((info) => info.name));
  for (const name of LEGACY_NAMES) {
    if (!existing.has(name)) {
      dump[name] = null;
      continue;
    }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const stores: Record<string, unknown> = {};
    for (const storeName of [...database.objectStoreNames].sort()) {
      const tx = database.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const [keys, values] = await Promise.all([
        request(store.getAllKeys()),
        request(store.getAll()),
      ]);
      stores[storeName] = {
        indexes: [...store.indexNames].sort(),
        rows: await serialize(keys.map((key, index) => [key, values[index]])),
      };
    }
    dump[name] = { version: database.version, stores };
    database.close();
  }
  return dump;
}

/** Every localStorage key that is legacy input (quiz keys and the device learner key). */
export function legacyLocalStorage(storage: MemoryStorage): [string, string][] {
  return [...storage.values.entries()]
    .filter(([key]) =>
      /^(quizDraft|quizAnswers|quizResults|quizAttemptId):|^maic:device:runtime\.learnerKey$/.test(
        key,
      ),
    )
    .sort(([a], [b]) => a.localeCompare(b));
}
