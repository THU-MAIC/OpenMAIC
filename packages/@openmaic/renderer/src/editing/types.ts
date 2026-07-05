import type { CSSProperties, ReactNode } from 'react';
import type { Slide, PPTElement, PPTImageElement, PPTVideoElement } from '@openmaic/dsl';

/**
 * Editing surface types (renderer v2). These are the **L1** contract from the
 * editing-surface RFC: the bounded, UI-driven vocabulary the canvas emits for
 * human gestures. They are intentionally *not* the agent tool surface (L2, which
 * is expected to churn and lives outside this package) nor the canonical change
 * representation (L0, which belongs in @openmaic/dsl). L1 normalizes down to L0.
 */

export type ReorderCommand = 'front' | 'back' | 'forward' | 'backward';
export type AlignCommand = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

/**
 * A single canvas edit intent. The canvas emits these on gesture commit; the host
 * owns the document and undo and applies them. One intent (or batch) per completed
 * gesture — never per animation frame — so it maps 1:1 onto one host undo entry.
 */
export type EditIntent =
  | { type: 'element.update'; id: string; props: Partial<PPTElement> }
  | { type: 'element.updateMany'; updates: Array<{ id: string; props: Partial<PPTElement> }> }
  | { type: 'element.add'; element: PPTElement; index?: number }
  | { type: 'element.delete'; ids: string[] }
  | { type: 'element.reorder'; id: string; command: ReorderCommand }
  | { type: 'element.align'; ids: string[]; command: AlignCommand }
  | { type: 'element.removeProps'; id: string; props: string[] }
  | { type: 'text.updateContent'; id: string; content: string; target: 'text' | 'shape' };

/**
 * Controlled selection. The host owns it; the canvas reports changes via
 * onSelectionChange. Id-based (not position-based) so it survives document edits.
 */
export interface Selection {
  /** readonly: the host owns selection and treats it immutably */
  elementIds: readonly string[];
  primaryId?: string;
  groupId?: string;
  editingId?: string;
}

/** Immutable empty-selection sentinel. Frozen so a shared reference can't be mutated. */
export const EMPTY_SELECTION: Selection = Object.freeze({
  elementIds: Object.freeze([] as string[]),
});

export interface SnappingOptions {
  toElements?: boolean;
  toCanvas?: boolean;
  /** snap threshold in px */
  range?: number;
}

export interface EditableSlideCanvasProps {
  /** Controlled document — the host owns it (and undo). */
  slide: Slide;
  scale?: number;

  /**
   * Controlled selection. Optional in this scaffold: the Stage 0 shell renders
   * read-only and supports click-to-select only. It becomes the primary
   * interaction contract once Part A lands operate handles.
   */
  selection?: Selection;
  onSelectionChange?: (next: Selection) => void;

  /**
   * The document-mutation channel. The canvas emits L1 intents here; the host
   * applies them and owns undo. Not yet emitted by the Stage 0 shell — wired up
   * as Part A moves the gesture machinery into the package.
   */
  onElementsChange?: (intents: EditIntent[]) => void;

  /** Host-injected media render slots (v1 behaviour preserved). */
  renderImage?: (element: PPTImageElement, resolvedSrc: string) => ReactNode;
  renderVideo?: (element: PPTVideoElement) => ReactNode;

  /** Editor affordances (no-ops until Part A). */
  snapping?: boolean | SnappingOptions;
  grid?: 0 | 25 | 50 | 100;
  ruler?: boolean;

  className?: string;
  style?: CSSProperties;
}
