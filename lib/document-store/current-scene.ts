/** Device-scoped editor position, separate from the canonical document. */
import { BrowserKVStore, type KVStore } from '@openmaic/storage';

export interface CurrentSceneValue {
  sceneId: string | null;
  updatedAt: string;
}

export interface CurrentSceneDeps {
  kv?: KVStore;
}

const KEY_PREFIX = 'editor-current-scene:';
let defaultKv: KVStore | undefined;

function key(stageId: string): string {
  return `${KEY_PREFIX}${stageId}`;
}

function resolveKv(kv?: KVStore): KVStore {
  if (kv) return kv;
  if (typeof localStorage === 'undefined')
    throw new Error('Current-scene persistence requires localStorage (client-only)');
  return (defaultKv ??= new BrowserKVStore());
}

function isCurrentSceneValue(value: unknown): value is CurrentSceneValue {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CurrentSceneValue>;
  return (
    (candidate.sceneId === null || typeof candidate.sceneId === 'string') &&
    typeof candidate.updatedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.updatedAt))
  );
}

export async function loadCurrentSceneValue(
  stageId: string,
  kv: KVStore,
): Promise<CurrentSceneValue | null> {
  const value = await kv.get<unknown>(key(stageId), 'device');
  return isCurrentSceneValue(value) ? value : null;
}

export function saveCurrentSceneValue(
  stageId: string,
  value: CurrentSceneValue,
  kv: KVStore,
): Promise<void> {
  return kv.set(key(stageId), value, 'device');
}

export function loadCurrentScene(
  stageId: string,
  deps: CurrentSceneDeps = {},
): Promise<CurrentSceneValue | null> {
  return loadCurrentSceneValue(stageId, resolveKv(deps.kv));
}

/** Last-write-wins device position. */
export function saveCurrentScene(
  stageId: string,
  sceneId: string | null,
  deps: CurrentSceneDeps = {},
): Promise<void> {
  return saveCurrentSceneValue(
    stageId,
    { sceneId, updatedAt: new Date().toISOString() },
    resolveKv(deps.kv),
  );
}

export function clearCurrentScene(stageId: string, deps: CurrentSceneDeps = {}): Promise<void> {
  return resolveKv(deps.kv).remove(key(stageId), 'device');
}
