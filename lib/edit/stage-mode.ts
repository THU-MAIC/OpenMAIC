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
  /** The workspace pane is visible and has not entered full-screen learning. */
  workbenchShowingClassroom: boolean;
  /** Owner and scene eligibility have both been resolved for this render. */
  isEditable: boolean;
  /** Prevents mounting an editor shell before a current scene exists. */
  hasCurrentScene: boolean;
  /** The loaded stage belongs to the classroom currently hosted by the pane. */
  stageMatchesHost: boolean;
  /** Editor-only side effects have registered their authoring surfaces. */
  editorReady: boolean;
  /** Loading failed, so the classroom must remain usable in read-only mode. */
  editorLoadFailed: boolean;
}

export type StageChromeResolution = StageMode | 'loading';

/**
 * Resolve the chrome synchronously for the current host.
 *
 * A hosted classroom is edit-first: workspace visibility is the edit intent,
 * while Start Learning is represented by `workbenchShowingClassroom=false`.
 * This deliberately does not round-trip through the transient stage-store
 * mode, so the first paint and course switches cannot inherit playback/edit
 * state from a previous course. Standalone classrooms retain their stored
 * manual mode unchanged.
 */
export function resolveStageChromeMode(ctx: StageChromeModeContext): StageChromeResolution {
  if (!ctx.hosted) return ctx.storedMode;
  // During a course switch the shared store can briefly still contain the
  // previous course. Neither chrome may mount against that stale document.
  if (!ctx.stageMatchesHost) return 'loading';
  if (!ctx.workbenchShowingClassroom || !ctx.isEditable || !ctx.hasCurrentScene) {
    return 'playback';
  }
  if (ctx.editorLoadFailed) return 'playback';
  // Surface registration is intentionally non-reactive. Mounting edit before
  // preload resolves would strand EditShell on its NOOP fallback, so show a
  // neutral shell rather than flashing playback while the chunk arrives.
  return ctx.editorReady ? 'edit' : 'loading';
}
