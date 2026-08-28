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
  /**
   * The pane's edit lock (`WorkbenchPanelState.editPinned`): the pane is on
   * screen and the user has not pressed Start Learning.
   */
  workbenchShowingClassroom: boolean;
  /**
   * The user pressed Start Learning: the pane went full-screen and IS the
   * learning surface. The single door out of the edit lock.
   */
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

/**
 * Resolve the chrome synchronously for the current host.
 *
 * A hosted classroom is EDIT-LOCKED, not merely edit-first. Inside the
 * workspace pane there is exactly one way to reach the learning chrome:
 * `workbenchLearning`, which is the user pressing Start Learning. Every other
 * input below only says how far along the edit chrome is — and an unready edit
 * chrome resolves to the neutral `loading` shell, never to playback.
 *
 * That asymmetry is the whole fix. The learning chrome used to be the default
 * branch, so any transient shortfall painted it: a course the agent had just
 * created has no scenes for a beat, and the pane answered with the full
 * playback chrome — speed control, play button, learner avatars, mic bar —
 * then flipped to edit once the first scene landed. Readiness is now a
 * spectrum between `loading` and `edit`; playback is not on it.
 *
 * This deliberately does not round-trip through the transient stage-store
 * mode, so the first paint and course switches cannot inherit playback/edit
 * state from a previous course. Standalone classrooms retain their stored
 * manual mode unchanged.
 */
export function resolveStageChromeMode(ctx: StageChromeModeContext): StageChromeResolution {
  if (!ctx.hosted) return ctx.storedMode;
  // Start Learning, and nothing else, opens the learning chrome in the pane.
  if (ctx.workbenchLearning) return 'playback';
  // During a course switch the shared store can briefly still contain the
  // previous course. Neither chrome may mount against that stale document.
  if (!ctx.stageMatchesHost) return 'loading';
  // Folded away. The edit chrome drops (it holds editor resources for a pane
  // nobody is looking at) but the learning chrome must NOT take its place
  // behind the fold: unfolding would then cross-fade a full classroom's
  // playback chrome out over the pane the user just reopened.
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
