/**
 * Host adapter: apply L1 EditIntents from `edit_elements` through the existing
 * slide edit session as ONE editor transaction.
 *
 * Apply-time revalidation: the gate ran against a turn-start inventory; before
 * writing we re-check ids/locks/groups against live content and refuse the
 * whole batch if anything drifted (never partial apply).
 */

import {
  applyEditorTransaction,
  createEditorTransaction,
  type EditIntent,
  type EditorOperation,
} from '@openmaic/editor/core';
import type { PPTElement, PPTShapeElement } from '@openmaic/dsl';
import { SHAPE_PATH_FORMULAS } from '@/configs/shapes';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import type { SlideContent } from '@/lib/types/stage';
import { editElementsOutcome } from '@/lib/agent/client/edit-elements-result';
import {
  elementInventorySnapshotFingerprint,
  revalidateIntentsAgainstElements,
  SHAPE_TEXT_CHROME_PROPS,
} from '@/lib/agent/tools/edit-elements-gate';

export interface EditElementsApplyDetails {
  sceneId?: string;
  intents?: EditIntent[] | null;
  updateCount?: number;
  /** Element types captured when the server-side gate accepted the batch. */
  targetElementTypes?: Record<string, string>;
  /** Mutable element state captured before the model call, keyed by target id. */
  targetElementFingerprints?: Record<string, string>;
  /** Full prompt-visible inventory captured before the model call. */
  inventoryFingerprint?: string;
  /** Present when the tool or host refused; retained for agent history and diagnostics. */
  refuseReason?: string;
}

export type ApplyEditElementsResult = { ok: true } | { ok: false; reason: string };

const MERGED_STYLE_PROPS = new Set(['outline', 'shadow', 'filters']);

function mergedElementPatch(
  element: PPTElement,
  props: Partial<PPTElement>,
): Record<string, unknown> {
  const patch = { ...(props as Record<string, unknown>) };
  const current = element as unknown as Record<string, unknown>;
  for (const property of MERGED_STYLE_PROPS) {
    const existing = current[property];
    const update = patch[property];
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      update &&
      typeof update === 'object' &&
      !Array.isArray(update)
    ) {
      patch[property] = {
        ...(existing as Record<string, unknown>),
        ...(update as Record<string, unknown>),
      };
    }
  }
  return patch;
}

/** Compile the agent's L1 vocabulary to editor operations without mutating content. */
function compileAgentEditOperations(
  content: SlideContent,
  intents: EditIntent[],
): EditorOperation[] {
  let working = content;
  const compiled: EditorOperation[] = [];

  const append = (operations: EditorOperation[]) => {
    if (operations.length === 0) return;
    working = applyEditorTransaction(
      working,
      createEditorTransaction({ origin: 'system', history: 'neutral', operations }),
    );
    compiled.push(...operations);
  };

  const compileUpdate = (element: PPTElement, props: Partial<PPTElement>) => {
    const patch = mergedElementPatch(element, props);
    if (element.type === 'shape') {
      const shape = element as PPTShapeElement;
      const textPatch: Record<string, unknown> = {};
      for (const key of Object.keys(patch)) {
        if (SHAPE_TEXT_CHROME_PROPS.has(key)) {
          textPatch[key] = patch[key];
          delete patch[key];
        } else if (key === 'vAlign') {
          textPatch.align = patch[key];
          delete patch[key];
        }
      }

      const operations: EditorOperation[] = [];
      if ('gradient' in patch) {
        operations.push({
          type: 'element.removeProps',
          elementId: shape.id,
          propNames: ['pattern'],
        });
      } else if ('fill' in patch) {
        operations.push({
          type: 'element.removeProps',
          elementId: shape.id,
          propNames: ['pattern', 'gradient'],
        });
      }
      if (('width' in patch || 'height' in patch) && shape.pathFormula) {
        const formula = SHAPE_PATH_FORMULAS[shape.pathFormula];
        if (formula) {
          const width = typeof patch.width === 'number' ? patch.width : shape.width;
          const height = typeof patch.height === 'number' ? patch.height : shape.height;
          patch.viewBox = [width, height];
          patch.path = formula.formula(
            width,
            height,
            formula.editable ? (shape.keypoints ?? formula.defaultValue) : undefined,
          );
        }
      }
      if (Object.keys(textPatch).length > 0) {
        patch.text = { ...shape.text, ...textPatch };
      }
      if (Object.keys(patch).length > 0) {
        operations.push({
          type: 'element.update',
          elementId: shape.id,
          patch: patch as Partial<PPTElement>,
        });
      }
      append(operations);
      return;
    }

    if (element.type === 'table' && typeof patch.height === 'number') {
      const nextHeight = patch.height;
      if (element.data.length > 0) {
        patch.cellMinHeight = Math.max(
          36,
          element.cellMinHeight + (nextHeight - element.height) / element.data.length,
        );
      }
      if (element.rowHeights?.length && element.height > 0) {
        const scale = nextHeight / element.height;
        patch.rowHeights = element.rowHeights.map((height) => height * scale);
      }
    }

    append([
      { type: 'element.update', elementId: element.id, patch: patch as Partial<PPTElement> },
    ]);
  };

  for (const intent of intents) {
    const elements = working.canvas.elements;
    if (intent.type === 'element.update') {
      const element = elements.find((candidate) => candidate.id === intent.id);
      if (element) compileUpdate(element, intent.props);
    } else if (intent.type === 'element.updateMany') {
      for (const update of intent.updates) {
        const element = working.canvas.elements.find((candidate) => candidate.id === update.id);
        if (element) compileUpdate(element, update.props);
      }
    } else if (intent.type === 'element.removeProps') {
      if (elements.some((element) => element.id === intent.id)) {
        append([{ type: 'element.removeProps', elementId: intent.id, propNames: intent.props }]);
      }
    } else if (intent.type === 'text.updateContent') {
      const element = elements.find((candidate) => candidate.id === intent.id);
      if (intent.target === 'text' && element?.type === 'text') {
        append([{ type: 'text.updateContent', elementId: element.id, content: intent.content }]);
      } else if (intent.target === 'shape' && element?.type === 'shape') {
        append([
          { type: 'shape.updateTextContent', elementId: element.id, content: intent.content },
        ]);
      }
    }
  }

  return compiled;
}

/**
 * Apply validated intents for a scene. Returns ok/reason.
 * Requires an open slide edit session for that scene (one undo via commitContent).
 * No silent stage-store fallback — that path had no undo and violated the contract.
 */
export function applyEditElementsIntents(
  sceneId: string,
  intents: EditIntent[],
  targetElementTypes?: Record<string, string>,
  targetElementFingerprints?: Record<string, string>,
  inventoryFingerprint?: string,
): ApplyEditElementsResult {
  if (!intents.length) return { ok: false, reason: 'no element updates proposed' };

  const pendingReplacementProps = new Map<string, Set<string>>();
  for (const intent of intents) {
    if (intent.type === 'element.removeProps') {
      if (
        intent.props.length === 0 ||
        new Set(intent.props).size !== intent.props.length ||
        intent.props.some((prop) => !MERGED_STYLE_PROPS.has(prop))
      ) {
        return { ok: false, reason: 'invalid structured-property replace marker' };
      }
      let pending = pendingReplacementProps.get(intent.id);
      if (!pending) {
        pending = new Set();
        pendingReplacementProps.set(intent.id, pending);
      }
      if (intent.props.some((prop) => pending.has(prop))) {
        return { ok: false, reason: 'invalid structured-property replace marker' };
      }
      for (const prop of intent.props) pending.add(prop);
      continue;
    }

    const updates =
      intent.type === 'element.update'
        ? [{ id: intent.id, props: intent.props }]
        : intent.type === 'element.updateMany'
          ? intent.updates
          : [];
    for (const update of updates) {
      const pending = pendingReplacementProps.get(update.id);
      if (!pending) continue;
      for (const prop of Object.keys(update.props)) {
        if (!pending.has(prop)) continue;
        const value = (update.props as Record<string, unknown>)[prop];
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return { ok: false, reason: 'invalid structured-property replace marker' };
        }
        pending.delete(prop);
      }
      if (pending.size === 0) pendingReplacementProps.delete(update.id);
    }
  }
  if (pendingReplacementProps.size > 0) {
    return { ok: false, reason: 'invalid structured-property replace marker' };
  }

  const session = useSlideEditSession.getState();
  if (session.sceneId !== sceneId || !session.history) {
    return {
      ok: false,
      reason: 'no open edit session for this scene; open Pro mode on the target slide first',
    };
  }
  if (session.gestureActive) {
    return { ok: false, reason: 'a canvas gesture is still in progress' };
  }

  const present = session.history.present;
  if (present.type !== 'slide') {
    return { ok: false, reason: 'edit session content is not a slide' };
  }

  if (
    inventoryFingerprint &&
    elementInventorySnapshotFingerprint(present.canvas.elements as PPTElement[]) !==
      inventoryFingerprint
  ) {
    return { ok: false, reason: 'slide elements changed while the edit was being prepared' };
  }

  const recheck = revalidateIntentsAgainstElements(
    present.canvas.elements as PPTElement[],
    intents,
    targetElementTypes,
    targetElementFingerprints,
  );
  if (!recheck.ok) return { ok: false, reason: recheck.reason };

  const byId = new Map((present.canvas.elements as PPTElement[]).map((el) => [el.id, el] as const));
  for (const intent of intents) {
    if (intent.type !== 'text.updateContent') continue;
    const element = byId.get(intent.id);
    if (intent.target === 'text' && element?.type !== 'text') {
      return { ok: false, reason: `element ${JSON.stringify(intent.id)} is not a text element` };
    }
    if (intent.target === 'shape' && (element?.type !== 'shape' || !element.text)) {
      return { ok: false, reason: `shape ${JSON.stringify(intent.id)} has no text label to edit` };
    }
  }

  // Refuse fabricating shape.text when the shape has no label (no content authoring).
  for (const intent of intents) {
    const updates =
      intent.type === 'element.update'
        ? [{ id: intent.id, props: intent.props as Record<string, unknown> }]
        : intent.type === 'element.updateMany'
          ? intent.updates.map((u) => ({
              id: u.id,
              props: u.props as Record<string, unknown>,
            }))
          : [];
    for (const u of updates) {
      const el = byId.get(u.id);
      if (!el || el.type !== 'shape') continue;
      const touchesText = Object.keys(u.props).some(
        (k) => SHAPE_TEXT_CHROME_PROPS.has(k) || k === 'vAlign',
      );
      if (touchesText && !(el as { text?: unknown }).text) {
        return {
          ok: false,
          reason: `shape ${JSON.stringify(u.id)} has no text label to style`,
        };
      }
    }
  }

  const operations = compileAgentEditOperations(present, intents);
  if (operations.length === 0) {
    return { ok: false, reason: 'nothing changed (targets missing after revalidation)' };
  }
  const transaction = createEditorTransaction({ origin: 'agent', history: 'record', operations });
  const next = applyEditorTransaction(present, transaction);
  if (next === present) {
    return { ok: false, reason: 'nothing changed (targets missing after revalidation)' };
  }
  session.applyTransaction(transaction);
  return { ok: true };
}

/** True when tool details carry applyable edit_elements intents. */
export function hasEditElementsIntents(
  details: EditElementsApplyDetails | null | undefined,
): details is EditElementsApplyDetails & { sceneId: string; intents: EditIntent[] } {
  return (
    !!details && typeof details.sceneId === 'string' && editElementsOutcome(details) === 'applied'
  );
}
