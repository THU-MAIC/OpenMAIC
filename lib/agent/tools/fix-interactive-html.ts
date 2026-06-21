/**
 * `fix_interactive_html` agent tool
 *
 * Surgically fixes a bug in an INTERACTIVE scene's HTML to match a teacher's
 * natural-language report (e.g. "the start button does nothing"). Mirrors the
 * `regenerate_scene` trust boundary: the model supplies only `sceneId` +
 * `bugDescription`; the page's current HTML comes from the trusted
 * client-injected `SceneContext` (`getSceneContext`) — the model never authors
 * the page.
 *
 * interactive-only: non-interactive scenes (and interactive scenes with no html)
 * get a typed refusal and nothing is generated.
 *
 * Returns `{ sceneId, html }` in `details`; the client reads `tool_execution_end`,
 * snapshots the pre-fix InteractiveContent, and writes the new html (preserving
 * url / widgetType / widgetConfig / teacherActions). The iframe reloads via srcDoc.
 */

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { fixInteractiveHtml } from '@/lib/generation/fix-interactive-html';
import type { RegenerateActionsDeps, SceneContext } from './regenerate-scene-actions';

// ── Params (trust boundary: only id + bug description; html comes from deps) ──

export const FixInteractiveHtmlParams = Type.Object({
  sceneId: Type.String({
    description:
      'The id of the interactive scene to fix. Use the id of the current scene shown in the system prompt.',
  }),
  bugDescription: Type.String({
    description:
      "A concise natural-language description of the bug to fix, restated from the user's report " +
      '(e.g. "the reset button does nothing when clicked", "the animation never appears", ' +
      '"the panels overlap on a phone"). Do NOT include HTML here — the current page is loaded automatically.',
  }),
});

export type FixInteractiveHtmlParams = Static<typeof FixInteractiveHtmlParams>;

// ── Details returned to the client ───────────────────────────────────────────

export interface FixInteractiveHtmlDetails {
  sceneId: string;
  /** The fixed HTML, or null when the scene was refused / the fix failed. */
  html: string | null;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function makeFixInteractiveHtmlTool(
  deps: RegenerateActionsDeps,
): AgentTool<typeof FixInteractiveHtmlParams, FixInteractiveHtmlDetails> {
  return {
    name: 'fix_interactive_html',
    label: 'Fix interactive page',
    description:
      'Fixes a bug in an INTERACTIVE scene (an interactive web page / widget) — e.g. a button ' +
      'that does nothing, a control with no effect, an animation that never shows, or a layout ' +
      'glitch. Supply the sceneId and a concise description of the bug; the current page is loaded ' +
      'automatically and only the reported problem is changed. Works on interactive scenes only.',
    parameters: FixInteractiveHtmlParams,

    execute: async (_toolCallId, params) => {
      const { sceneId, bugDescription } = params;

      const ctxData: SceneContext | undefined = deps.getSceneContext(sceneId);
      if (!ctxData) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: scene context not found for sceneId "${sceneId}". Cannot fix the page.`,
            },
          ],
          details: { sceneId, html: null },
          isError: true,
        };
      }

      const { content } = ctxData;

      // interactive-only — refuse non-interactive scenes, and interactive scenes
      // with no embedded html (nothing to edit).
      if (content.type !== 'interactive' || !content.html) {
        return {
          content: [
            {
              type: 'text',
              text:
                'Cannot fix this scene: fixing the page is only supported for interactive scenes ' +
                'that have embedded HTML. Suggest the user edits this scene on the canvas instead.',
            },
          ],
          details: { sceneId, html: null },
          isError: true,
        };
      }

      const fixed = await fixInteractiveHtml(content.html, bugDescription, deps.aiCall);

      if (!fixed) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Warning: could not produce a fixed page for "${bugDescription}". ` +
                `The page has NOT been changed.`,
            },
          ],
          details: { sceneId, html: null },
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: `Fixed the interactive page (${bugDescription}).` }],
        details: { sceneId, html: fixed },
      };
    },
  };
}
