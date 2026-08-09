import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  makeRegenerateSceneActionsTool,
  type RegenerateActionsDeps,
} from './regenerate-scene-actions';
import { makeReadSceneContentTool } from './read-scene-content';
import { makeRegenerateSceneTool } from './regenerate-scene';
import { makeEditInteractiveHtmlTool } from './edit-interactive-html';
import { makeEditElementsTool } from './edit-elements';

/**
 * Deps needed to build the v0 toolset.
 * - `aiCall`: request-scoped LLM text call (resolved model injected by route)
 * - `getSceneContext`: returns trusted scene/stage context from the client POST body;
 *   the model supplies only a sceneId, and the route fulfils the heavy data.
 * - `getSelection`: optional canvas selection ids (shown by read_scene_content).
 *
 * Tools share the regenerate deps shape; the read tool only uses `getSceneContext`.
 */
export type ToolsetDeps = RegenerateActionsDeps & {
  activeSceneId?: string;
  getSelection?: () => readonly string[];
};

/**
 * Build the v0 toolset:
 * - `read_scene_content` — read the slide to reason / craft instructions (read-then-act)
 * - `regenerate_scene` — instruction-driven whole-slide regeneration (content + actions)
 * - `regenerate_scene_actions` — narration/actions only
 * - `edit_interactive_html` — surgical str_replace edits for an interactive scene's HTML
 * - `edit_elements` — guarded JSON Patch per-element edits → EditIntent
 */
export function buildToolset(deps: ToolsetDeps): AgentTool<never, never>[] {
  return [
    makeReadSceneContentTool(deps) as never,
    makeRegenerateSceneTool(deps) as never,
    makeRegenerateSceneActionsTool(deps) as never,
    makeEditInteractiveHtmlTool(deps) as never,
    makeEditElementsTool(deps) as never,
  ];
}

/** v0 allowlist — the enabled subset. Widen here to grant capability. */
export const V0_ALLOWLIST: ReadonlySet<string> = new Set([
  'read_scene_content',
  'regenerate_scene',
  'regenerate_scene_actions',
  'edit_interactive_html',
  'edit_elements',
]);
