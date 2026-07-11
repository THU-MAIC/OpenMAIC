export interface StageSavedPBLScene {
  sceneId: string;
  project: unknown;
}

export interface StageSavedPayload {
  stageId: string;
  pblScenes: StageSavedPBLScene[];
}

type StageSavedListener = (payload: StageSavedPayload) => void;

const stageSavedListeners = new Set<StageSavedListener>();

export function onStageSaved(listener: StageSavedListener): () => void {
  stageSavedListeners.add(listener);
  return () => {
    stageSavedListeners.delete(listener);
  };
}

export function emitStageSaved(payload: StageSavedPayload): void {
  for (const listener of [...stageSavedListeners]) {
    listener(payload);
  }
}
