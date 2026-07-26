import type { DocumentStore } from '@openmaic/storage';

import type { AppScene } from '@/lib/types/stage';
import { omitUndefinedObjectMembers } from '@/lib/persistence/plain-json';

import type { AppStage } from './persistence-types';

const wrappers = new WeakMap<
  DocumentStore<AppScene, AppStage>,
  DocumentStore<AppScene, AppStage>
>();

export function withPlainJsonDocumentWrites(
  store: DocumentStore<AppScene, AppStage>,
): DocumentStore<AppScene, AppStage> {
  const existing = wrappers.get(store);
  if (existing) return existing;

  const methods: DocumentStore<AppScene, AppStage> = {
    saveDocument(document) {
      return store.saveDocument(omitUndefinedObjectMembers(document));
    },
    loadDocument(stageId) {
      return store.loadDocument(stageId);
    },
    listDocuments() {
      return store.listDocuments();
    },
    deleteDocument(stageId) {
      return store.deleteDocument(stageId);
    },
    putStage(stageId, stage) {
      return store.putStage(stageId, omitUndefinedObjectMembers(stage));
    },
    putScene(stageId, scene) {
      return store.putScene(stageId, omitUndefinedObjectMembers(scene));
    },
    getScene(stageId, sceneId) {
      return store.getScene(stageId, sceneId);
    },
    deleteScene(stageId, sceneId) {
      return store.deleteScene(stageId, sceneId);
    },
  };
  const wrapper = new Proxy(store, {
    get(target, property) {
      if (Object.hasOwn(methods, property)) {
        return Reflect.get(methods, property, methods) as unknown;
      }
      return Reflect.get(target, property, target) as unknown;
    },
  });
  wrappers.set(store, wrapper);
  wrappers.set(wrapper, wrapper);
  return wrapper;
}
