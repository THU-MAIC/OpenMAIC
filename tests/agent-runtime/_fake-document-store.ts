/**
 * Shared in-memory DocumentStore facade for the stage route tests.
 *
 * Route tests inject this facade at `getOwnerScopedDocumentStore`. It already
 * represents one owner: seeding it with a document means that owner may mutate
 * it, and an absent id is missing.
 *
 * The facade also mirrors the PG backend's trigger-maintained freshness
 * revisions: every write method bumps the stage revision, and a scene write
 * bumps that scene's revision, exactly like the DB triggers the real store
 * relies on. Route tests seed `stageRevs` / `sceneRevs` to fix the numbers a
 * manifest response must carry.
 */
import type {
  DocumentFolder,
  DocumentFolderStore,
  DocumentStore,
  MaicDocument,
  StageFreshnessManifestStore,
} from '@openmaic/storage';

import type { AppStage } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';

export interface FakeDocumentStore {
  store: OwnerScopedFakeStore;
  docs: Map<string, MaicDocument<AppScene, AppStage>>;
  /** Per-stage revisions, mirroring the `document_stage_revision` trigger rows. */
  stageRevs: Map<string, number>;
  /** Per-(stage, scene) revisions, mirroring the `document_scene_revision` rows. */
  sceneRevs: Map<string, Map<string, number>>;
  saveCalls: MaicDocument<AppScene, AppStage>[];
  /** Make the next saveDocument call throw (e.g. a validation failure). */
  failNextSaveWith(error: unknown): void;
}

/** The fake store is already one owner's partition, so scoping is identity. */
export type OwnerScopedFakeStore = DocumentStore<AppScene, AppStage> &
  StageFreshnessManifestStore &
  DocumentFolderStore & { forOwner(ownerId: string): OwnerScopedFakeStore };

export function createFakeDocumentStore(): FakeDocumentStore {
  const docs = new Map<string, MaicDocument<AppScene, AppStage>>();
  const stageRevs = new Map<string, number>();
  const sceneRevs = new Map<string, Map<string, number>>();
  const saveCalls: MaicDocument<AppScene, AppStage>[] = [];
  let saveError: unknown = null;

  const bumpStage = (stageId: string) => {
    stageRevs.set(stageId, (stageRevs.get(stageId) ?? 0) + 1);
  };
  const bumpScene = (stageId: string, sceneId: string) => {
    bumpStage(stageId);
    const perScene = sceneRevs.get(stageId) ?? new Map<string, number>();
    perScene.set(sceneId, (perScene.get(sceneId) ?? 0) + 1);
    sceneRevs.set(stageId, perScene);
  };
  const revOf = (stageId: string, sceneId: string) => sceneRevs.get(stageId)?.get(sceneId) ?? 0;

  // In-memory folder store, one owner's partition (same as `docs`).
  const folders = new Map<string, DocumentFolder>();
  const stageFolder = new Map<string, string | null>();
  let nextOrder = 0;

  const store = {
    forOwner: () => store,
    async saveDocument(doc: MaicDocument<AppScene, AppStage>) {
      if (saveError) throw saveError;
      saveCalls.push(structuredClone(doc));
      docs.set(doc.stage.id, structuredClone(doc));
      const stageId = doc.stage.id;
      bumpStage(stageId);
      const incoming = new Set(doc.scenes.map((scene) => scene.id));
      for (const scene of doc.scenes) bumpScene(stageId, scene.id);
      // Scenes the coarse save no longer contains are gone; drop their rows
      // the way the DELETE cascade would.
      const perScene = sceneRevs.get(stageId);
      if (perScene) {
        for (const sceneId of [...perScene.keys()]) {
          if (!incoming.has(sceneId)) perScene.delete(sceneId);
        }
      }
    },
    async loadDocument(stageId: string) {
      const doc = docs.get(stageId);
      return doc ? structuredClone(doc) : null;
    },
    async readFreshnessManifest(stageId: string) {
      const doc = docs.get(stageId);
      if (!doc) return null;
      return {
        rev: stageRevs.get(stageId) ?? 0,
        scenes: [...doc.scenes]
          .sort((left, right) => left.order - right.order)
          .map((scene) => ({
            id: scene.id,
            order: scene.order,
            rev: revOf(stageId, scene.id),
          })),
      };
    },
    async listDocuments() {
      return [...docs.values()]
        .map((doc) => ({
          id: doc.stage.id,
          name: doc.stage.name,
          ...(doc.stage.description ? { description: doc.stage.description } : {}),
          createdAt: doc.stage.createdAt,
          updatedAt: doc.stage.updatedAt,
          sceneCount: doc.scenes.length,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
    },
    async deleteDocument(stageId: string) {
      docs.delete(stageId);
      stageRevs.delete(stageId);
      sceneRevs.delete(stageId);
    },
    async putStage(stageId: string, stage: AppStage) {
      const doc = docs.get(stageId);
      if (!doc) throw new Error('@openmaic/storage: document not found');
      docs.set(stageId, { ...doc, stage });
      bumpStage(stageId);
    },
    async putScene(stageId: string, scene: AppScene) {
      const doc = docs.get(stageId);
      if (!doc) throw new Error('@openmaic/storage: document not found');
      docs.set(stageId, {
        ...doc,
        scenes: [...doc.scenes.filter((s) => s.id !== scene.id), scene].sort(
          (left, right) => left.order - right.order,
        ),
      });
      bumpScene(stageId, scene.id);
    },
    async getScene(stageId: string, sceneId: string) {
      return docs.get(stageId)?.scenes.find((scene) => scene.id === sceneId) ?? null;
    },
    async deleteScene(stageId: string, sceneId: string) {
      const doc = docs.get(stageId);
      if (doc) {
        docs.set(stageId, { ...doc, scenes: doc.scenes.filter((scene) => scene.id !== sceneId) });
      }
      bumpStage(stageId);
      sceneRevs.get(stageId)?.delete(sceneId);
    },
    async listFolders(): Promise<DocumentFolder[]> {
      return [...folders.values()].sort((left, right) => left.order - right.order);
    },
    async createFolder(
      folderId: string,
      name: string,
      _limit?: number,
    ): Promise<{ folder: DocumentFolder; reused: boolean }> {
      const existing = [...folders.values()].find(
        (folder) => folder.name.toLowerCase() === name.toLowerCase(),
      );
      if (existing) return { folder: existing, reused: true };
      const now = Date.now();
      const folder: DocumentFolder = {
        id: folderId,
        name,
        order: nextOrder,
        createdAt: now,
        updatedAt: now,
      };
      nextOrder += 1;
      folders.set(folderId, folder);
      return { folder, reused: false };
    },
    async renameFolder(id: string, name: string): Promise<DocumentFolder | null> {
      const folder = folders.get(id);
      if (!folder) return null;
      const updated = { ...folder, name, updatedAt: Date.now() };
      folders.set(id, updated);
      return updated;
    },
    async deleteFolder(
      id: string,
      mode: 'ungroup' | 'remove',
    ): Promise<{ removedStageIds: string[] } | null> {
      if (!folders.has(id)) return null;
      const removedStageIds =
        mode === 'remove'
          ? [...stageFolder.entries()]
              .filter(([, folderId]) => folderId === id)
              .map(([stageId]) => stageId)
              .sort()
          : [];
      for (const stageId of [...stageFolder.keys()]) {
        if (stageFolder.get(stageId) === id) stageFolder.set(stageId, null);
      }
      folders.delete(id);
      return { removedStageIds };
    },
    async moveDocumentToFolder(stageId: string, folderId: string): Promise<boolean> {
      return this.setStageFolder(stageId, folderId);
    },
    async setStageFolder(stageId: string, folderId: string | null): Promise<boolean> {
      if (folderId === null) {
        stageFolder.set(stageId, null);
        return true;
      }
      if (!folders.has(folderId)) return false;
      stageFolder.set(stageId, folderId);
      return true;
    },
  } as OwnerScopedFakeStore;

  return {
    store,
    docs,
    stageRevs,
    sceneRevs,
    saveCalls,
    failNextSaveWith(error) {
      saveError = error;
    },
  };
}
