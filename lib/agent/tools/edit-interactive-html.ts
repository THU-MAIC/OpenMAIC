/**
 * `edit_interactive_html` agent tool
 *
 * Surgically fixes bugs in an INTERACTIVE scene's HTML with exact-text
 * ("str_replace") edits — the coding-agent pattern. The model reads the page
 * (via `read_scene_content`, which returns the full HTML for interactive scenes)
 * and emits one or more `{ oldText, newText }` edits as the tool arguments; this
 * tool applies them DETERMINISTICALLY against the trusted current HTML. There is
 * no second LLM call here — the agent's own turn authored the edits — so it is
 * instant and can't truncate a large page (unlike a whole-page rewrite).
 *
 * Trust boundary (carries the v0 rule): the model supplies only `sceneId` + the
 * edits; the page's current HTML comes from the trusted client-injected
 * `SceneContext` (`getSceneContext`). interactive-only.
 *
 * On any unappliable edit (oldText not found / not unique / overlapping / no-op)
 * the vendored applier throws a model-actionable message; we surface it as a
 * tool error so the agent retries with a better anchor (the pi loop supports the
 * multi-turn retry). Returns `{ sceneId, html }` for the client to apply.
 */

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { applyHtmlEdits, type Edit } from '@/lib/edit/html-edit';
import type { RegenerateActionsDeps, SceneContext } from './regenerate-scene-actions';

// ── Params (trust boundary: only id + edits; html comes from deps) ───────────

export const EditInteractiveHtmlParams = Type.Object({
  sceneId: Type.String({
    description:
      'The id of the interactive scene to edit. Use the id of the current scene shown in the system prompt.',
  }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({
        description:
          'Exact text to find in the current page HTML — copied verbatim, including whitespace. ' +
          'Must be UNIQUE in the page; keep it as small as possible while still unique. Do not overlap edits.',
      }),
      newText: Type.String({
        description:
          'The replacement for this region. Preserve the surrounding structure: keep all HTML tags, ' +
          'attributes and ids that appear in oldText — to change only a visible label, include the ' +
          'enclosing tags in BOTH oldText and newText and change just the text between them (e.g. ' +
          'oldText "<button id="go">Start</button>" → newText "<button id="go">Begin</button>"). ' +
          'Never drop an element or its id when you only mean to change its text or one attribute.',
      }),
    }),
    {
      minItems: 1,
      description:
        'One or more targeted str_replace edits applied to the current HTML. Each oldText is matched ' +
        'against the original page (not after earlier edits); merge nearby changes into one edit.',
    },
  ),
});

export type EditInteractiveHtmlParams = Static<typeof EditInteractiveHtmlParams>;

// ── Details returned to the client ───────────────────────────────────────────

export interface EditInteractiveHtmlDetails {
  sceneId: string;
  /** The edited HTML, or null when the scene was refused / the edits didn't apply. */
  html: string | null;
  /** Number of edits applied (0 on failure). */
  editCount: number;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function makeEditInteractiveHtmlTool(
  deps: RegenerateActionsDeps,
): AgentTool<typeof EditInteractiveHtmlParams, EditInteractiveHtmlDetails> {
  return {
    name: 'edit_interactive_html',
    label: 'Edit interactive page',
    description:
      'Fixes bugs in an INTERACTIVE scene (an interactive web page / widget) by applying exact-text ' +
      'edits to its HTML — e.g. a button that does nothing, a control with no effect, a layout glitch. ' +
      'First call read_scene_content to see the page HTML, then supply the sceneId and one or more ' +
      '{ oldText, newText } edits (oldText must be a unique exact substring of the current HTML). ' +
      'Works on interactive scenes only; only the matched regions change, everything else is preserved.',
    parameters: EditInteractiveHtmlParams,

    execute: async (_toolCallId, params) => {
      const { sceneId, edits } = params;

      const ctxData: SceneContext | undefined = deps.getSceneContext(sceneId);
      if (!ctxData) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: scene context not found for sceneId ${JSON.stringify(String(sceneId).slice(0, 200))}. Cannot edit the page.`,
            },
          ],
          details: { sceneId, html: null, editCount: 0 },
          isError: true,
        };
      }

      const { content } = ctxData;
      if (content.type !== 'interactive' || !content.html) {
        return {
          content: [
            {
              type: 'text',
              text:
                'Cannot edit this scene: editing is only supported for interactive scenes that have ' +
                'embedded HTML. Suggest the user edits this scene on the canvas instead.',
            },
          ],
          details: { sceneId, html: null, editCount: 0 },
          isError: true,
        };
      }

      let newHtml: string;
      try {
        newHtml = applyHtmlEdits(content.html, edits as Edit[], 'the interactive page');
      } catch (err) {
        // Anchor not found / not unique / overlapping / no-op: surface the
        // actionable message so the agent retries with a better oldText.
        return {
          content: [
            {
              type: 'text',
              text: `Edit failed: ${err instanceof Error ? err.message : String(err)} The page has NOT been changed.`,
            },
          ],
          details: { sceneId, html: null, editCount: 0 },
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Applied ${edits.length} edit(s) to the interactive page.`,
          },
        ],
        details: { sceneId, html: newHtml, editCount: edits.length },
      };
    },
  };
}
