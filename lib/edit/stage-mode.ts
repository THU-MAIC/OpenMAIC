import { PENDING_SCENE_ID } from '@/lib/store/stage';
import type { StageMode } from '@/lib/types/stage';

/**
 * Inputs the edit-mode auto-exit guard reads. Kept as primitives so callers
 * can derive the values cheaply without holding full Scene / SceneOutline
 * objects, and so the predicate is trivially testable without rendering Stage.
 */
export interface StageEditModeContext {
  currentSceneId: string | null;
  sceneCount: number;
  generatingOutlineCount: number;
  hasCurrentScene: boolean;
}

/**
 * Whether edit mode should remain active for the given stage state.
 * Returns false in cases that would otherwise strand the user in an empty
 * edit shell — pending scene, no scenes, generation in flight, or no current
 * scene resolved yet.
 */
export function isCurrentSceneEditable(ctx: StageEditModeContext): boolean {
  if (ctx.currentSceneId === PENDING_SCENE_ID) return false;
  if (ctx.sceneCount === 0) return false;
  if (ctx.generatingOutlineCount > 0) return false;
  if (!ctx.hasCurrentScene) return false;
  return true;
}

export interface HostedStageEditContext extends StageEditModeContext {
  editorEnabled: boolean;
  isOwner: boolean;
  stageMatchesHost: boolean;
}

/**
 * Hosted editing is page-scoped: generation of later outlines must not lock a
 * current scene that has already materialised. Same-page/identity guards still
 * apply; `generatingOutlineCount` is intentionally not a blocker here.
 */
export function isHostedSceneEditable(ctx: HostedStageEditContext): boolean {
  if (!ctx.editorEnabled || !ctx.isOwner || !ctx.stageMatchesHost) return false;
  if (ctx.currentSceneId === null || ctx.currentSceneId === PENDING_SCENE_ID) return false;
  if (ctx.sceneCount === 0 || !ctx.hasCurrentScene) return false;
  return true;
}

export interface StageChromeModeContext {
  /** The transient mode used by a standalone classroom and its Pro switch. */
  storedMode: StageMode;
  /** Whether the classroom is mounted inside the workspace host. */
  hosted: boolean;
  /** The visible pane requests editing after applying its course/access gates. */
  workbenchShowingClassroom: boolean;
  /** The visible pane requests learning (embedded or full-screen). */
  workbenchLearning: boolean;
  /** Owner and scene eligibility have both been resolved for this render. */
  isEditable: boolean;
  /** Prevents mounting an editor shell before a current scene exists. */
  hasCurrentScene: boolean;
  /** The loaded stage belongs to the classroom currently hosted by the pane. */
  stageMatchesHost: boolean;
  /** Editor-only side effects have registered their authoring surfaces. */
  editorReady: boolean;
  /** The editor chunk failed to load, so the edit chrome cannot mount. */
  editorLoadFailed: boolean;
}

export type StageChromeResolution = StageMode | 'loading';

/** Resolve the host's mode without inheriting another course's transient state. */
export function resolveStageChromeMode(ctx: StageChromeModeContext): StageChromeResolution {
  if (!ctx.hosted) return ctx.storedMode;
  // During a course switch the shared store can briefly still contain the
  // previous course. Neither chrome may mount against that stale document.
  if (!ctx.stageMatchesHost) return 'loading';
  if (ctx.workbenchLearning) return 'playback';
  // A folded pane waits without mounting learning behind it. Reopening an
  // editing intent stays loading until ready; Stage only retains playback
  // when a learning surface was already mounted before the edit request.
  if (!ctx.workbenchShowingClassroom) return 'loading';
  // Not editable YET (no scenes, the pending placeholder, no current scene
  // resolved) — a stage of the load, not a request to learn.
  if (!ctx.isEditable || !ctx.hasCurrentScene) return 'loading';
  // The editor chunk did not arrive. The pane still refuses the learning
  // chrome; `preloadEditor` drops its cached failure so the next mount of a
  // hosted classroom retries the import.
  if (ctx.editorLoadFailed) return 'loading';
  // Surface registration is intentionally non-reactive. Mounting edit before
  // preload resolves would strand EditShell on its NOOP fallback, so show a
  // neutral shell rather than flashing playback while the chunk arrives.
  return ctx.editorReady ? 'edit' : 'loading';
}
