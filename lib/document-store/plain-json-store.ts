import type { DocumentStore } from '@openmaic/storage';

import type { AppScene } from '@/lib/types/stage';
import type {
  CreateOnlyDocumentStore,
  MutationOptions,
} from '@/lib/persistence/owner-bound-document-store';
import { omitUndefinedObjectMembers } from '@/lib/persistence/plain-json';

import type { AppStage } from './persistence-types';

let wrappers = new WeakMap<DocumentStore<AppScene, AppStage>, DocumentStore<AppScene, AppStage>>();

export function resetPlainJsonDocumentWritesForTests(): void {
  wrappers = new WeakMap();
}

/**
 * Wrap a document store so every write strips undefined-valued members before
 * persisting (the agent tools' boundary). The wrapper is a Proxy over the
 * underlying store, so capabilities the `DocumentStore` interface does not
 * declare (such as the PG store's `readFreshnessManifest`) fall through to the
 * store itself; the generic return type keeps them visible to callers.
 */
export function withPlainJsonDocumentWrites<TStore extends DocumentStore<AppScene, AppStage>>(
  store: TStore,
): TStore {
  const existing = wrappers.get(store);
  if (existing) return existing as TStore;

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
    putScene(stageId, scene, ...options: [MutationOptions?]) {
      // The owner-bound store's scene write takes options (its transaction's own rows).
      return (store.putScene as (...args: unknown[]) => Promise<void>).call(
        store,
        stageId,
        omitUndefinedObjectMembers(scene),
        ...options,
      );
    },
    getScene(stageId, sceneId) {
      return store.getScene(stageId, sceneId);
    },
    deleteScene(stageId, sceneId) {
      return store.deleteScene(stageId, sceneId);
    },
  };
  // The create-only write of the owner-bound store, when the store has one.
  const createOnly = store as Partial<CreateOnlyDocumentStore<AppScene, AppStage>>;
  if (typeof createOnly.mutateScene === 'function') {
    const mutateScene = createOnly.mutateScene.bind(store);
    Object.assign(methods, {
      mutateScene: (...[stageId, sceneId, mutate, after]: Parameters<typeof mutateScene>) =>
        mutateScene(
          stageId,
          sceneId,
          (scene) => {
            const next = mutate(scene);
            return next ? omitUndefinedObjectMembers(next) : null;
          },
          after,
        ),
    });
  }
  if (typeof createOnly.createDocument === 'function') {
    const createDocument = createOnly.createDocument.bind(store);
    Object.assign(methods, {
      createDocument: (
        document: Parameters<typeof createDocument>[0],
        options?: Parameters<typeof createDocument>[1],
      ) => createDocument(omitUndefinedObjectMembers(document), options),
    });
  }
  const facade = Object.create(Object.getPrototypeOf(store)) as TStore;
  Object.defineProperties(facade, Object.getOwnPropertyDescriptors(methods));
  const wrapper = new Proxy(facade, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver) as unknown;
      }
      return Reflect.get(store, property, store) as unknown;
    },
  });
  wrappers.set(store, wrapper);
  wrappers.set(wrapper, wrapper);
  return wrapper as TStore;
}
