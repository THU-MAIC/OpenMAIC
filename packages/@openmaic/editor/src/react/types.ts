import type { CSSProperties, ReactNode } from 'react';
import type {
  Slide,
  PPTImageElement,
  PPTShapeElement,
  PPTTableElement,
  PPTVideoElement,
} from '@openmaic/dsl';
import type { EditIntent } from '../core';
import type {
  TextAutoSizeIntent,
  TextContentChange,
  TextEditorController,
  TextFormatState,
} from './text/types';
import type { ShapePathFormulaMap } from './shape/types';

/**
 * Editing surface types (renderer v2). These are the **L1** contract from the
 * editing-surface RFC: the bounded, UI-driven vocabulary the canvas emits for
 * human gestures. They are intentionally *not* the agent tool surface (L2, which
 * is expected to churn and lives outside this package) nor the canonical change
 * representation (L0, which belongs in @openmaic/dsl). L1 normalizes down to L0.
 */

export type { AlignCommand, EditIntent, ReorderCommand } from '../core';

/**
 * The draggable handles on a line element. `start`/`end` are the two endpoints;
 * `ctrl` is the single quadratic/broken control point (`broken`/`broken2`/`curve`);
 * `ctrl1`/`ctrl2` are the two cubic control points (`cubic`).
 */
export type LineHandle = 'start' | 'end' | 'ctrl' | 'ctrl1' | 'ctrl2';

/**
 * A single canvas edit intent. The canvas emits these on gesture commit; the host
 * owns the document and undo and applies them. One intent (or batch) per completed
 * gesture — never per animation frame — so it maps 1:1 onto one host undo entry.
 */
export interface TableCellChange {
  readonly intent: Extract<EditIntent, { type: 'table.updateCell' }>;
  readonly history: 'record' | 'neutral' | 'navigate';
}

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

/** Canvas-space rectangle emitted after an armed text-insertion click or drag. */
export interface TextCreateRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Canvas-space endpoints emitted after an armed line-insertion drag. */
export interface LineCreateGeometry {
  readonly start: [number, number];
  readonly end: [number, number];
}

/** Immutable empty-selection sentinel. Frozen so a shared reference can't be mutated. */
export const EMPTY_SELECTION: Selection = Object.freeze({
  elementIds: Object.freeze([] as string[]),
});

export interface SnappingOptions {
  toElements?: boolean;
  toCanvas?: boolean;
  /**
   * Snap threshold in canvas units (viewportSize space), not screen px — it is
   * compared against un-scaled element bounds for app parity.
   */
  range?: number;
}

export interface EditableSlideCanvasProps {
  /** Controlled document — the host owns it (and undo). */
  slide: Slide;
  scale?: number;
  /** Reports the auto-fit scale so host-owned overlay tools share renderer coordinates. */
  onScaleChange?: (scale: number) => void;

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

  /** Rich-text editor lifecycle emitted by an active Text element. */
  onTextContentChange?: (change: TextContentChange) => void;
  onTextAutoSize?: (intent: TextAutoSizeIntent) => void;
  onTextFormatChange?: (elementId: string, state: TextFormatState) => void;
  onTextEditorChange?: (controller: TextEditorController | null) => void;
  onTextFocusChange?: (focused: boolean) => void;
  onTableCellChange?: (change: TableCellChange) => void;
  /** Host-localized affordance shown for a selected table before editing starts. */
  tableEditMaskLabel?: string;

  /** Arms a crosshair canvas layer for a click/drag text-box insertion gesture. */
  creatingText?: boolean;
  /** Host-owned text creation: the renderer emits geometry while the host creates the DSL element. */
  onTextCreate?: (rect: TextCreateRect) => void;

  /** Arms a crosshair canvas layer for a draw-to-insert Line gesture. */
  creatingLine?: boolean;
  /** Host-owned line creation: the renderer emits endpoints while the host creates the DSL element. */
  onLineCreate?: (geometry: LineCreateGeometry) => void;
  /** Cancels an armed line-insertion mode, for example through a context click. */
  onLineCreateCancel?: () => void;

  /** Optional host-owned geometry formulas for editable Shape keypoints. */
  shapePathFormulas?: ShapePathFormulaMap;

  /** Host-injected media render slots (v1 behaviour preserved). */
  renderImage?: (
    element: PPTImageElement,
    resolvedSrc: string,
    defaultContent: ReactNode,
  ) => ReactNode;
  renderShapeLabel?: (element: PPTShapeElement, defaultContent: ReactNode) => ReactNode;
  renderTable?: (element: PPTTableElement, defaultContent: ReactNode) => ReactNode;
  renderVideo?: (element: PPTVideoElement) => ReactNode;
  videoInteractive?: boolean;

  /** Prefix used for each rendered element root DOM id. */
  elementIdPrefix?: string;

  /** Host-controlled element ids omitted from rendering and interaction. */
  hiddenElementIds?: readonly string[];

  /** Editor affordances (no-ops until Part A). */
  snapping?: boolean | SnappingOptions;
  grid?: 0 | 25 | 50 | 100;
  ruler?: boolean;

  className?: string;
  style?: CSSProperties;
}
