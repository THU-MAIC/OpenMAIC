/**
 * Scene-context → slide-ops bridge.
 *
 * The slide renderer (`components/slide-renderer`) commits every edit by
 * handing its scene-context provider a whole post-edit `SlideContent`
 * (drag/resize/rotate hooks call `updateSlide({ elements })`). The edit
 * surface owns a real `SlideEditHistory` of canonical `SlideEditOperation`s
 * (so undo/redo, persistence and PPTX round-trip stay coherent), not an
 * opaque content blob. This module diffs the committed snapshot back into
 * the ops the kernel + export pipeline understand.
 *
 * Pure + dependency-free so it is unit-testable in isolation; the React
 * wiring (which feeds `next` in and stores the resulting history) lives in
 * the slide surface.
 */

import { isEqual } from 'lodash';
import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement } from '@maic/dsl';
import { applySlideEditOperation, MAX_HISTORY } from '@/lib/edit/slide-ops';
import type { SlideEditHistory, SlideEditOperation } from '@/lib/edit/slide-ops';

type AnyRecord = Record<string, unknown>;

function changedKeys(prev: AnyRecord, next: AnyRecord, skip: ReadonlySet<string>) {
  const patch: AnyRecord = {};
  const removed: string[] = [];
  for (const key of Object.keys(next)) {
    if (skip.has(key)) continue;
    if (!(key in prev) || !isEqual(prev[key], next[key])) {
      patch[key] = next[key];
    }
  }
  for (const key of Object.keys(prev)) {
    if (skip.has(key)) continue;
    if (!(key in next)) removed.push(key);
  }
  return { patch, removed };
}

const ELEMENT_SKIP = new Set(['id']);
const SLIDE_META_SKIP = new Set(['elements', 'animations']);

/**
 * Diff two `SlideContent` snapshots into the canonical ops that transform
 * `prev` into `next`. Returns `[]` when they are deep-equal.
 */
export function deriveSlideEditOperations(
  prev: SlideContent,
  next: SlideContent,
): SlideEditOperation[] {
  const ops: SlideEditOperation[] = [];

  const prevById = new Map(prev.canvas.elements.map((el) => [el.id, el]));
  const nextById = new Map(next.canvas.elements.map((el) => [el.id, el]));

  for (const el of prev.canvas.elements) {
    if (!nextById.has(el.id)) ops.push({ type: 'element.delete', elementId: el.id });
  }

  next.canvas.elements.forEach((el, index) => {
    const before = prevById.get(el.id);
    if (!before) {
      ops.push({ type: 'element.add', element: el, index });
      return;
    }
    if (isEqual(before, el)) return;
    if (before.type !== el.type) {
      // Identity reused for a different element type — model as replace so
      // the kernel's per-type invariants stay intact.
      ops.push({ type: 'element.delete', elementId: el.id });
      ops.push({ type: 'element.add', element: el, index });
      return;
    }
    const { patch, removed } = changedKeys(
      before as unknown as AnyRecord,
      el as unknown as AnyRecord,
      ELEMENT_SKIP,
    );
    if (Object.keys(patch).length > 0) {
      ops.push({ type: 'element.update', elementId: el.id, patch: patch as Partial<PPTElement> });
    }
    if (removed.length > 0) {
      ops.push({ type: 'element.removeProps', elementId: el.id, propNames: removed });
    }
  });

  const { patch: metaPatch } = changedKeys(
    prev.canvas as unknown as AnyRecord,
    next.canvas as unknown as AnyRecord,
    SLIDE_META_SKIP,
  );
  if (Object.keys(metaPatch).length > 0) {
    ops.push({ type: 'slide.update', patch: metaPatch });
  }

  return ops;
}

/**
 * Apply a renderer-committed `next` snapshot onto `history` as exactly ONE
 * undo transaction.
 *
 * A single pointer gesture (one drag/resize/rotate, possibly affecting
 * several selected elements) is one user action and must be one undo step.
 * - No effective change → history is returned untouched (same reference).
 * - Exactly one derived op → delegate to the kernel's history overload so
 *   capping / no-op-skip semantics are single-sourced.
 * - Several ops (multi-element gesture) → fold them onto `present` via the
 *   content overload, then push a single past entry.
 */
export function commitSlideEdit(history: SlideEditHistory, next: SlideContent): SlideEditHistory {
  const ops = deriveSlideEditOperations(history.present, next);
  if (ops.length === 0) return history;
  if (ops.length === 1) return applySlideEditOperation(history, ops[0]);

  // Multi-element gesture = one undo step. Use the renderer's authoritative
  // snapshot as `present` rather than replaying derived ops onto it: the
  // diff intentionally doesn't model reorder/animations, so a replay could
  // silently diverge from what the renderer actually rendered.
  return {
    past: [...history.past, history.present].slice(-MAX_HISTORY),
    present: next,
    future: [],
  };
}
