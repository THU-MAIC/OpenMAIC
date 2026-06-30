/**
 * Pure apply logic for MAIC Agent tool results (client side).
 *
 * `regenerate_scene` returns generation-shaped slide content; the stage store
 * holds runtime `SceneContent` ({ type:'slide', canvas: Slide }). This module
 * converts between them (preserving the user's existing canvas) and decides
 * what to apply + what to snapshot for the "restore previous" button — kept
 * pure and side-effect-free so it can be unit-tested without React/Dexie.
 */
import { nanoid } from 'nanoid';
import type { Action } from '@/lib/types/action';
import type { Scene, SceneContent, InteractiveContent } from '@/lib/types/stage';
import type { GeneratedSlideContent } from '@/lib/types/generation';
import { CURRENT_SLIDE_CONTENT_SCHEMA_VERSION } from '@/lib/edit/slide-schema';

// Mirrors the default theme minted by createSceneWithActions for fresh slides.
const DEFAULT_THEME = {
  backgroundColor: '#ffffff',
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
  fontColor: '#333333',
  fontName: 'Microsoft YaHei',
  outline: { color: '#d14424', width: 2, style: 'solid' },
  shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
};

/**
 * Convert generated slide content to runtime SlideContent, preserving the
 * scene's EXISTING canvas (id / viewport / theme) and overriding only the
 * elements + background. Mints a default canvas only when the scene has none.
 */
export function toRuntimeSlideContent(
  gen: GeneratedSlideContent,
  existingCanvas?: Record<string, unknown>,
): SceneContent {
  const base = existingCanvas ?? {
    id: nanoid(),
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: DEFAULT_THEME,
  };
  return {
    type: 'slide',
    // schemaVersion belongs at the SlideContent top level (sibling of `canvas`),
    // where slide-defaults / createBlankSlideScene put it and migrateSlideContent
    // reads it — not inside the canvas object.
    schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
    canvas: {
      ...base,
      elements: gen.elements,
      // Replacing ALL elements with freshly-minted ids strands any persisted
      // animations on `base` — they reference element ids that no longer exist
      // (mirrors how slide edit ops drop animations whose elId is deleted).
      // Every new element has a brand-new id, so nothing survives a filter;
      // clear the array.
      animations: [],
      // Only override background when defined — a regen that omits background
      // must not wipe the scene's existing background.
      ...(gen.background !== undefined ? { background: gen.background } : {}),
    },
  } as unknown as SceneContent;
}

export interface RegenerateDetails {
  sceneId?: string;
  /** Present for `regenerate_scene` (whole-slide); absent for actions-only. */
  content?: GeneratedSlideContent | null;
  /** Present for `edit_interactive_html` — the edited interactive page HTML. */
  html?: string | null;
  actions?: Action[];
}

export interface RegenerateApplyPlan {
  /** Pre-regenerate scene state to keep for restore (both regenerate tools). */
  snapshot: {
    sceneId: string;
    content: SceneContent;
    actions: Action[];
    /** True for narration-only regen — restore reverts actions only, not content. */
    actionsOnly?: boolean;
  } | null;
  /** Partial scene update to apply, or null if nothing should change. */
  patch: Partial<Scene> | null;
}

/**
 * Decide how to apply a tool result.
 * - `regenerate_scene` (content present): snapshot the current scene, then apply
 *   the converted content plus actions (actions only when non-empty — an empty
 *   array would wipe the narration).
 * - `regenerate_scene_actions` (no content): apply actions only when non-empty,
 *   and snapshot the prior narration so it can be reverted too.
 */
export function planRegenerateApply(
  details: RegenerateDetails,
  scene: Pick<Scene, 'content' | 'actions'> | null,
  toolName?: string,
): RegenerateApplyPlan {
  const { sceneId } = details;
  if (!sceneId) return { snapshot: null, patch: null };

  const actions = Array.isArray(details.actions) ? details.actions : [];

  // `edit_interactive_html` carries the edited interactive-page HTML. Snapshot
  // the current scene, then write the new html onto the existing
  // InteractiveContent — preserving the page's other fields (url / widgetType /
  // widgetConfig). The iframe reloads when content.html changes.
  if (toolName === 'edit_interactive_html' && typeof details.html === 'string') {
    const prev = scene?.content as InteractiveContent | undefined;
    if (!prev || prev.type !== 'interactive') return { snapshot: null, patch: null };
    const runtime: InteractiveContent = { ...prev, html: details.html };
    const snapshot = scene
      ? { sceneId, content: scene.content, actions: scene.actions ?? [] }
      : null;
    return { snapshot, patch: { content: runtime as SceneContent } };
  }

  // Defensive: only `regenerate_scene` carries whole-slide content. When the
  // tool name is known and is anything else, treat the result as actions-only
  // (a non-regenerate tool that happens to echo a content-shaped payload must
  // not clobber the slide). Undefined toolName keeps the legacy shape-based
  // behaviour for back-compat.
  const contentAllowed = toolName === undefined || toolName === 'regenerate_scene';

  if (contentAllowed && details.content && Array.isArray(details.content.elements)) {
    const sceneContent = scene?.content as
      | { type?: string; canvas?: Record<string, unknown> }
      | undefined;
    const existingCanvas = sceneContent?.type === 'slide' ? sceneContent.canvas : undefined;
    const runtime = toRuntimeSlideContent(details.content, existingCanvas);
    const patch: Partial<Scene> = {
      content: runtime,
      ...(actions.length > 0 ? { actions } : {}),
    };
    const snapshot = scene
      ? { sceneId, content: scene.content, actions: scene.actions ?? [] }
      : null;
    return { snapshot, patch };
  }

  if (actions.length > 0) {
    // Narration-only regen: snapshot the prior actions so this card can offer
    // Restore too. `actionsOnly` so restore reverts ONLY the actions — the slide
    // content is unchanged here, and re-applying it would clobber later canvas
    // edits + needlessly reseed the edit session.
    const snapshot = scene
      ? { sceneId, content: scene.content, actions: scene.actions ?? [], actionsOnly: true }
      : null;
    return { snapshot, patch: { actions } };
  }
  return { snapshot: null, patch: null };
}
