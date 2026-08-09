/**
 * `edit_elements` agent tool
 *
 * The agent authors guarded RFC 6902 `test`/`add`/`replace` operations against the
 * trusted slide canvas. This tool validates the complete batch and converts it
 * to the existing host EditIntent vocabulary. The client still owns the live
 * document, apply-time revalidation, persistence, and one-step undo.
 */

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { EditIntent } from '@openmaic/renderer/editing';
import type { PPTElement } from '@openmaic/dsl';
import type { RegenerateActionsDeps, SceneContext } from './regenerate-scene-actions';
import {
  buildElementInventory,
  elementInventoryFingerprint,
  elementInventorySnapshotFingerprint,
  type ElementInventoryItem,
} from './edit-elements-gate';
import { mapElementJsonPatchToEditIntents } from './edit-elements-patch';

const ElementPatchOperation = Type.Object(
  {
    op: Type.Union([Type.Literal('test'), Type.Literal('add'), Type.Literal('replace')]),
    path: Type.String({ description: 'RFC 6901 path rooted at /elements.' }),
    value: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const EditElementsParams = Type.Object({
  sceneId: Type.String({
    description:
      'The id of the SLIDE scene to edit. Use the id of the current scene shown in the system prompt.',
  }),
  patches: Type.Array(ElementPatchOperation, {
    description:
      'Guarded JSON Patch operations. Before adding or replacing /elements/N/..., first test /elements/N/id.',
  }),
  reason: Type.String({
    description: 'Short user-facing summary of the requested element edit.',
  }),
});

export type EditElementsParams = Static<typeof EditElementsParams>;

export interface EditElementsDetails {
  sceneId: string;
  intents: EditIntent[] | null;
  updateCount: number;
  refuseReason?: string;
  targetElementTypes?: Record<string, string>;
  targetElementFingerprints?: Record<string, string>;
  inventoryFingerprint?: string;
}

export type EditElementsDeps = RegenerateActionsDeps;

function targetTypes(
  targetIds: readonly string[],
  inventory: ElementInventoryItem[],
): Record<string, string> {
  const byId = new Map(inventory.map((element) => [element.id, element.type] as const));
  return Object.fromEntries(
    targetIds.flatMap((id) => {
      const type = byId.get(id);
      return type ? [[id, type] as const] : [];
    }),
  );
}

function targetFingerprints(
  targetIds: readonly string[],
  elements: PPTElement[],
): Record<string, string> {
  const byId = new Map(elements.map((element) => [element.id, element] as const));
  return Object.fromEntries(
    targetIds.flatMap((id) => {
      const element = byId.get(id);
      return element ? [[id, elementInventoryFingerprint(element)] as const] : [];
    }),
  );
}

export function makeEditElementsTool(
  deps: EditElementsDeps,
): AgentTool<typeof EditElementsParams, EditElementsDetails> {
  return {
    name: 'edit_elements',
    label: 'Edit slide elements',
    description:
      'Atomically edits existing elements on a SLIDE scene with guarded JSON Patch operations. ' +
      'Call read_scene_content first to obtain the indexed element JSON. Before changing any ' +
      '/elements/N/... path, test /elements/N/id against the id you just read. Supports existing ' +
      'geometry and renderer-visible style properties plus text and shape-label HTML content. ' +
      'Supports test, add for optional properties, and replace; it cannot add elements. ' +
      'Value contract: geometry/opacity are numbers; colors are CSS color strings; outline is ' +
      '{width,style,color}; shadow is {h,v,blur,color}; image filters use unitless numeric strings ' +
      '(for example brightness "120" and blur "2"); line width is stroke thickness. Preserve ' +
      'existing structured fields and units exactly, and change only requested paths.',
    parameters: EditElementsParams,

    execute: async (_toolCallId, params) => {
      const { sceneId, patches } = params;
      const ctxData: SceneContext | undefined = deps.getSceneContext(sceneId);
      if (!ctxData) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: scene context not found for sceneId ${JSON.stringify(String(sceneId).slice(0, 200))}.`,
            },
          ],
          details: {
            sceneId,
            intents: null,
            updateCount: 0,
            refuseReason: 'scene context not found',
          },
          isError: true,
        };
      }

      const { content } = ctxData;
      if (content.type !== 'slide') {
        return {
          content: [
            {
              type: 'text',
              text:
                'Cannot edit elements on this scene: edit_elements works on SLIDE scenes only. ' +
                'For interactive pages use edit_interactive_html; otherwise suggest the canvas.',
            },
          ],
          details: {
            sceneId,
            intents: null,
            updateCount: 0,
            refuseReason: 'not a slide scene',
          },
          isError: true,
        };
      }

      const elements = (content.canvas?.elements ?? []) as PPTElement[];
      if (elements.length === 0) {
        return {
          content: [{ type: 'text', text: 'This slide has no elements to edit.' }],
          details: {
            sceneId,
            intents: null,
            updateCount: 0,
            refuseReason: 'slide has no elements',
          },
          isError: true,
        };
      }

      const gated = mapElementJsonPatchToEditIntents(patches, elements);
      if (!gated.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `Could not apply the edit: ${gated.reason}. Nothing was changed.`,
            },
          ],
          details: {
            sceneId,
            intents: null,
            updateCount: 0,
            refuseReason: gated.reason,
          },
          isError: true,
        };
      }

      const inventory = buildElementInventory(elements);
      return {
        content: [
          {
            type: 'text',
            text:
              `Validated a JSON Patch batch for ${gated.targetIds.length} element(s). ` +
              `Do not claim the canvas already changed: the client may still refuse a stale ` +
              `slide, a locked target, an active canvas gesture, or a missing Pro edit session.`,
          },
        ],
        details: {
          sceneId,
          intents: gated.intents,
          updateCount: gated.targetIds.length,
          targetElementTypes: targetTypes(gated.targetIds, inventory),
          targetElementFingerprints: targetFingerprints(gated.targetIds, elements),
          inventoryFingerprint: elementInventorySnapshotFingerprint(elements),
        },
      };
    },
  };
}
