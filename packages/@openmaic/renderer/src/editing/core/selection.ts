import type { PPTElement } from '@openmaic/dsl';
import type { Selection } from '../types';

/**
 * Pure click-selection resolution for the editing surface, shared by every
 * pointer-down entry point (box hit targets and line stroke blockers) so all
 * element kinds resolve modifiers and groups identically. No React, no store,
 * no `@/` imports — plain data in, plain data out.
 */

/** True when a click/drag selection modifier (Ctrl/Shift/Meta) is held. Meta is
 * included for mac parity with the resize aspect modifier — a deliberate
 * superset of the app's Ctrl/Shift. */
export function isSelectionModifier(e: {
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): boolean {
  return e.ctrlKey || e.shiftKey || e.metaKey;
}

/** Dedup ids preserving first-seen order (no lodash dep in this package). */
export function uniqIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

/** Exact ordered id-list equality for no-op emit guards. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * The clicked element's cohesion unit: every member of its group (in element
 * order), or just the element itself when ungrouped. Group cohesion is
 * all-or-nothing at the click entry point too (app parity): selecting,
 * adding, or removing a grouped element always applies to the whole group,
 * so a group can never be half-selected by clicking. Locked members are
 * included — they may sit in the selection for feedback; the drag layer is
 * responsible for never translating them.
 */
export function groupMemberIds(el: PPTElement, elements: readonly PPTElement[]): string[] {
  if (!el.groupId) return [el.id];
  const members = elements.filter((o) => o.groupId === el.groupId).map((o) => o.id);
  return members.length > 0 ? members : [el.id];
}

/**
 * Group-close a host-provided selection: every known selected element expands
 * to its full group unit, while unknown ids are preserved in-place. This keeps
 * externally controlled selection state from leaking a split group into click
 * resolution or into the drag set it returns.
 */
function closeSelectionGroupIds(ids: readonly string[], elements: readonly PPTElement[]): string[] {
  const byId = new Map(elements.map((el) => [el.id, el]));
  const closed: string[] = [];
  for (const id of ids) {
    const el = byId.get(id);
    closed.push(...(el ? groupMemberIds(el, elements) : [id]));
  }
  return uniqIds(closed);
}

export interface ClickSelectionInput {
  /** The element under the pointer. */
  element: PPTElement;
  /** The slide's elements (group-membership lookup). */
  elements: readonly PPTElement[];
  /** The current controlled selection. */
  selection: Selection;
  /** Whether a selection modifier (Ctrl/Shift/Meta) was held at pointer-down. */
  modifier: boolean;
}

export interface ClickSelectionResult {
  /** The selection to publish, or `null` when nothing changes (no emit). */
  next: Selection | null;
  /** Whether this pointer-down arms a move gesture (plain clicks only). */
  armDrag: boolean;
  /**
   * The ids an armed drag translates: the clicked element's group unit for a
   * fresh plain click, or the group-closed current selection for a plain click
   * on an already-selected element. Meaningless when `armDrag` is false.
   */
  dragIds: readonly string[];
}

/**
 * Resolve a pointer-down on element `el` against the current `selection` per
 * the modifier table (group-cohesive — `el` expands to its whole group unit):
 * - not selected, no modifier → select only the unit (primary = clicked);
 *   arm a drag on it.
 * - not selected, modifier    → ADD the unit to the selection (uniq,
 *   primary = clicked); no drag.
 * - selected, modifier        → REMOVE the unit; no-op if that would empty
 *   the selection; the current primary is preserved when it survives the
 *   removal, else the last remaining id becomes primary. No drag.
 * - selected, no modifier     → KEEP the whole selection, make the clicked
 *   element the primary (no emit when it already is), and arm a drag that
 *   translates every selected element.
 *
 * Invariant: this resolver never returns a selection or armed drag set that
 * splits a group, even when the incoming controlled selection already does.
 */
export function resolveClickSelection(input: ClickSelectionInput): ClickSelectionResult {
  const { element: el, elements, selection, modifier } = input;
  const rawIds = selection.elementIds;
  const ids = closeSelectionGroupIds(rawIds, elements);
  const inSelection = ids.includes(el.id);
  const unit = groupMemberIds(el, elements);

  if (!inSelection && !modifier) {
    return { next: { elementIds: unit, primaryId: el.id }, armDrag: true, dragIds: unit };
  }

  if (!inSelection && modifier) {
    return {
      next: { elementIds: uniqIds([...ids, ...unit]), primaryId: el.id },
      armDrag: false,
      dragIds: unit,
    };
  }

  if (inSelection && modifier) {
    const removed = new Set(unit);
    const remaining = ids.filter((id) => !removed.has(id));
    // A modifier click must never clear the selection to empty.
    if (remaining.length === 0) return { next: null, armDrag: false, dragIds: unit };
    const primaryId =
      selection.primaryId !== undefined && remaining.includes(selection.primaryId)
        ? selection.primaryId
        : remaining[remaining.length - 1];
    return { next: { elementIds: remaining, primaryId }, armDrag: false, dragIds: unit };
  }

  // Already selected, no modifier: keep the whole selection, re-point the
  // primary at the clicked element. Skip the emit only when the incoming
  // selection was already group-closed and already points at the clicked
  // primary, so a cohesive plain click doesn't double-emit.
  const unchanged = selection.primaryId === el.id && sameIds(ids, rawIds);
  return {
    next: unchanged ? null : { elementIds: ids, primaryId: el.id },
    armDrag: true,
    dragIds: ids,
  };
}
