/**
 * `/classroom/<id>?scene=<sceneId>` — a link that opens a classroom at one
 * scene. Exports (e.g. the PPTX placeholder slides) build these links; the
 * standalone classroom page applies the parameter once the course has loaded.
 * An unknown scene id is ignored and the classroom opens as usual.
 */

export const SCENE_QUERY_PARAM = 'scene';

/** Absolute URL of a classroom page on `origin`. */
export function classroomPageUrl(origin: string, classroomId: string): string {
  return `${origin.replace(/\/+$/, '')}/classroom/${encodeURIComponent(classroomId)}`;
}

/** `classroomUrl` with the scene parameter set, replacing any existing one. */
export function classroomSceneUrl(classroomUrl: string, sceneId: string): string {
  const url = new URL(classroomUrl);
  url.searchParams.set(SCENE_QUERY_PARAM, sceneId);
  return url.toString();
}

interface DeepLinkStore {
  getState(): {
    stage: { id: string } | null;
    scenes: ReadonlyArray<{ id: string }>;
  };
  setState(partial: { currentSceneId: string }): void;
}

/**
 * Open the scene named by `search` (a `location.search` string) if the loaded
 * course is `classroomId` and has that scene. Returns the applied scene id, or
 * null when nothing changed. The cursor is set without marking it as a pending
 * change: opening a link is not an edit, and the next navigation persists the
 * cursor as usual.
 */
export function applySceneDeepLink(
  search: string,
  classroomId: string,
  store: DeepLinkStore,
): string | null {
  const sceneId = new URLSearchParams(search).get(SCENE_QUERY_PARAM);
  if (!sceneId) return null;
  const { stage, scenes } = store.getState();
  if (stage?.id !== classroomId) return null;
  if (!scenes.some((scene) => scene.id === sceneId)) return null;
  store.setState({ currentSceneId: sceneId });
  return sceneId;
}
