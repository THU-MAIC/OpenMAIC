/**
 * SceneEditorSurface — interface contract for scene-type editors.
 *
 * The edit-mode shell (workbench + command bar + insert strip + inspector +
 * floating contextual bar) is scene-type-agnostic. Each SceneType registers a
 * SceneEditorSurface; the shell calls `useSurfaceState()` and renders the
 * returned slots. Phase 1 ships the slide surface; quiz / interactive / pbl
 * surfaces can plug in later without touching the shell.
 */

import type { ComponentType, ReactNode } from 'react';
import type { SceneContent, SceneType } from '@/lib/types/stage';

// ---------------------------------------------------------------------------
// Contribution primitives — shell renders these; surface only declares them.
// All carry user-facing label/icon/tooltip so the same item can render in
// novice-friendly big-label form (left strip) or compact form (floating bar).
// ---------------------------------------------------------------------------

export interface UiAffordance {
  id: string;
  label: string;
  icon?: ReactNode;
  tooltip?: string;
  disabled?: boolean;
  /** Optional grouping hint — shell may insert dividers between groups. */
  group?: string;
}

/** Items in the left "insert" strip (kept always-visible for discoverability). */
export interface InsertPaletteItem extends UiAffordance {
  onInvoke: () => void;
  /**
   * Optional popover content. When provided, the button opens a popover with
   * this content instead of firing onInvoke. Useful for sub-pickers like
   * "choose a shape" or "choose an image source".
   */
  popoverContent?: () => ReactNode;
  /**
   * Whether the item is in an "armed" state — e.g. the surface is waiting for
   * a canvas gesture to complete an insert. CommandBar renders this with the
   * active/toggle style. Defaults to false.
   */
  active?: boolean;
}

/**
 * Floating contextual actions — shown as an inline bar above the canvas when
 * selection is non-empty. Each action is either a one-shot button (onInvoke)
 * or a popover trigger (popoverContent) for property panels.
 */
export interface FloatingAction extends UiAffordance {
  onInvoke?: () => void;
  /**
   * Optional popover content. When provided, the button opens a popover
   * instead of (or in addition to, if onInvoke is also set) firing onInvoke.
   * Used for property surfaces like color picker, font select, etc.
   */
  popoverContent?: () => ReactNode;
}

/**
 * Editor commands — global actions surfaced in the top command bar.
 * Element-scoped actions (align, delete, layer) belong in `floatingActions`,
 * not here. `commands` is for things like Save / Export / Zoom / Exit-edit.
 */
export interface EditorCommand extends UiAffordance {
  onInvoke: () => void;
}

/**
 * AI inline coach hint — reserved slot, not used in Phase 1.
 * The shell renders a hint rail when this slot has any items.
 */
export interface EditorHint {
  id: string;
  severity: 'info' | 'suggestion' | 'warning';
  message: string;
  action?: { label: string; onInvoke: () => void };
}

// ---------------------------------------------------------------------------
// SurfaceState — what the surface's hook returns to the shell each render.
// ---------------------------------------------------------------------------

export interface SurfaceHistory {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

/**
 * **Maintenance note:** any new field added here that the chrome reads
 * must also be added to `surfaceStateEqual` in
 * `components/edit/EditShell/EditShell.tsx`. Surface hooks return a
 * fresh object each render, so semantic equality is the gate that
 * prevents an infinite publish loop — a new field outside the
 * comparison goes silently stale in the rendered chrome.
 */
export interface SurfaceState<TContent extends SceneContent = SceneContent, TSelection = unknown> {
  content: TContent;
  selection: TSelection;
  /** True when the surface considers selection non-empty (drives floating bar). */
  hasSelection: boolean;

  /**
   * Editable surfaces expose undo/redo here. Read-only surfaces (e.g. the
   * NOOP fallback used for unregistered scene types) omit it; the shell
   * hides undo/redo controls when undefined.
   */
  history?: SurfaceHistory;

  insertItems: InsertPaletteItem[];
  floatingActions: FloatingAction[];
  commands: EditorCommand[];

  /** Reserved for AI phase. Surface returns [] in Phase 1. */
  hints?: EditorHint[];
}

// ---------------------------------------------------------------------------
// SceneEditorSurface — the contract a scene type registers.
// ---------------------------------------------------------------------------

export interface SceneEditorSurface<
  TContent extends SceneContent = SceneContent,
  TSelection = unknown,
> {
  sceneType: SceneType;

  /**
   * Center surface region — the surface fully owns rendering. Paradigm-neutral
   * by design: the slide surface mounts a canvas here, the quiz surface a
   * structured form. (Renamed from `CanvasComponent` once the quiz surface
   * proved the slot is not canvas-specific.)
   */
  SurfaceComponent: ComponentType;

  /**
   * React hook called by the shell once per render. Owns selection, history,
   * and op dispatch internally; returns the slot contributions.
   */
  useSurfaceState: () => SurfaceState<TContent, TSelection>;
}

// ---------------------------------------------------------------------------
// Registry — shell resolves a surface by SceneType. Surfaces register once
// at module init time; the shell never imports surfaces directly.
// ---------------------------------------------------------------------------

export interface SceneEditorRegistry {
  register: <TContent extends SceneContent, TSelection>(
    surface: SceneEditorSurface<TContent, TSelection>,
  ) => void;
  /** Remove a registration. Mainly for HMR cleanup and tests. */
  unregister: (sceneType: SceneType) => void;
  resolve: (sceneType: SceneType) => SceneEditorSurface | undefined;
}
