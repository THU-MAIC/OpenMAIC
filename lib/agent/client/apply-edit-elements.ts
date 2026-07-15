/**
 * Host adapter: apply L1 EditIntents from `edit_elements` through the existing
 * slide edit session as ONE undo entry.
 *
 * EditableSlideCanvas's `onElementsChange` is not mounted in the app yet; this
 * adapter speaks the same EditIntent vocabulary so the canvas can take over
 * later without changing the tool contract. Mixed per-id props cannot use
 * slide-ops `element.updateMany` (shared patch), so we fold updates into one
 * `commitContent(..., true)`.
 *
 * Apply-time revalidation: the gate ran against a turn-start inventory; before
 * writing we re-check ids/locks/groups against live content and refuse the
 * whole batch if anything drifted (never partial apply).
 */

import type { EditIntent } from '@openmaic/renderer/editing';
import type { PPTElement, PPTShapeElement } from '@openmaic/dsl';
import { produce } from 'immer';
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

function assignElementProps(el: PPTElement, props: Record<string, unknown>): void {
  const target = el as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(props)) {
    const current = target[key];
    if (
      MERGED_STYLE_PROPS.has(key) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      target[key] = {
        ...(current as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else {
      target[key] = value;
    }
  }
}

/** Shape text-chrome keys are nested under `shape.text` (not top-level). */
function applyPropsToElement(el: PPTElement, props: Partial<PPTElement>): void {
  if (el.type === 'shape') {
    const rest: Record<string, unknown> = {};
    const textPatch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
      if (SHAPE_TEXT_CHROME_PROPS.has(key)) {
        textPatch[key] = value;
      } else if (key === 'vAlign') {
        textPatch.align = value;
      } else {
        rest[key] = value;
      }
    }
    const shape = el as PPTShapeElement;
    if ('gradient' in rest) {
      delete shape.pattern;
    } else if ('fill' in rest) {
      delete shape.pattern;
      delete shape.gradient;
    }
    assignElementProps(el, rest);
    if (('width' in rest || 'height' in rest) && shape.pathFormula) {
      const formula = SHAPE_PATH_FORMULAS[shape.pathFormula];
      if (formula) {
        shape.viewBox = [shape.width, shape.height];
        shape.path = formula.formula(
          shape.width,
          shape.height,
          formula.editable ? (shape.keypoints ?? formula.defaultValue) : undefined,
        );
      }
    }
    if (Object.keys(textPatch).length > 0) {
      shape.text = { ...shape.text, ...textPatch } as PPTShapeElement['text'];
    }
    return;
  }
  if (el.type === 'table' && 'height' in props) {
    const oldHeight = el.height;
    const oldCellMinHeight = el.cellMinHeight;
    const oldRowHeights = el.rowHeights;
    assignElementProps(el, props as Record<string, unknown>);
    if (el.data.length > 0) {
      el.cellMinHeight = Math.max(36, oldCellMinHeight + (el.height - oldHeight) / el.data.length);
    }
    if (oldRowHeights?.length && oldHeight > 0) {
      const scale = el.height / oldHeight;
      el.rowHeights = oldRowHeights.map((height) => height * scale);
    }
    return;
  }
  assignElementProps(el, props as Record<string, unknown>);
}

function applyIntentsToContent(content: SlideContent, intents: EditIntent[]): SlideContent {
  return produce(content, (draft) => {
    for (const intent of intents) {
      if (intent.type === 'element.update') {
        const el = draft.canvas.elements.find((e) => e.id === intent.id);
        if (!el) continue;
        applyPropsToElement(el, intent.props);
      } else if (intent.type === 'element.updateMany') {
        for (const u of intent.updates) {
          const el = draft.canvas.elements.find((e) => e.id === u.id);
          if (!el) continue;
          applyPropsToElement(el, u.props as Partial<PPTElement>);
        }
      } else if (intent.type === 'element.removeProps') {
        const el = draft.canvas.elements.find((e) => e.id === intent.id);
        if (!el) continue;
        const target = el as unknown as Record<string, unknown>;
        for (const prop of intent.props) delete target[prop];
      } else if (intent.type === 'text.updateContent') {
        const el = draft.canvas.elements.find((element) => element.id === intent.id);
        if (!el) continue;
        if (intent.target === 'text' && el.type === 'text') {
          el.content = intent.content;
        } else if (intent.target === 'shape' && el.type === 'shape' && el.text) {
          el.text.content = intent.content;
        }
      }
      // Other EditIntent kinds are out of scope for this vertical.
    }
  });
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

  const next = applyIntentsToContent(present, intents);
  if (next === present) {
    return { ok: false, reason: 'nothing changed (targets missing after revalidation)' };
  }
  session.commitContent(next, true);
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
