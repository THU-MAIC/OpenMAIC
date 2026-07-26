import type { DocumentStore, MaicDocument } from '@openmaic/storage';

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

  const wrapper = new Proxy(store, {
    get(target, property) {
      if (property === 'saveDocument') {
        return (document: MaicDocument<AppScene, AppStage>) =>
          target.saveDocument(omitUndefinedObjectMembers(document));
      }
      if (property === 'putStage') {
        return (stageId: string, stage: AppStage) =>
          target.putStage(stageId, omitUndefinedObjectMembers(stage));
      }
      if (property === 'putScene') {
        return (stageId: string, scene: AppScene) =>
          target.putScene(stageId, omitUndefinedObjectMembers(scene));
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' && !Object.hasOwn(target, property)
        ? value.bind(target)
        : value;
    },
  });
  wrappers.set(store, wrapper);
  return wrapper;
}
