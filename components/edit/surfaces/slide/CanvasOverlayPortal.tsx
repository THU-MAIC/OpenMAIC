'use client';

/**
 * CanvasOverlayPortal — a floating surface that belongs to the slide's canvas
 * area but is not clipped by it.
 *
 * The overlay this hosts (the insert palette, the element picker's list) must be
 * free to sit in the grey padding AROUND the beige slide card without either
 * being cut off or escaping to the timeline / pager / thumbnail rail. So its home
 * is the STUDIO FRAME — the padded, rounded canvas container that holds the card
 * (`data-maic-studio-frame`), the region from just under the pane's title row down
 * to just above the edit dock. Not the card (too small — clips, and pins the strip
 * against slide content), not the document viewport (too big — the widget could
 * wander onto the dock or off screen).
 *
 * The frame is `overflow-hidden`, so the overlay renders in a portal on
 * `document.body` in a `fixed` box placed exactly over the frame. Nothing else
 * changes for the children: the box has the frame's geometry, so `absolute`
 * positions, drag clamping and `getBoundingClientRect` measurements inside it mean
 * what they always meant — a child measured relative to this box lands at the same
 * screen point whether the box is the card or the frame. This is the same trick
 * `AnchoredBar` uses for the selection bars (a fixed virtual anchor plus a portaled
 * surface); it is spelled out here because these two overlays position themselves
 * rather than handing the job to Radix.
 *
 * `measureSelector` names the ancestor whose rect the box takes — the anchor still
 * lives inside the card (so it inherits the card's visibility for the folded-pane
 * case), but `closest(measureSelector)` walks up to the frame it is measured
 * against. The rect is tracked, not read once: the pane resizes, the window
 * scrolls, and a canvas zoom is an animated ancestor transform that no
 * ResizeObserver can see.
 *
 * `capturePointer` decides whether the portal's own box swallows pointer events.
 * The picker WANTS to (pick mode covers the whole canvas — a click means "this
 * element"); the palette must NOT (its box now spans the frame, over the card, and
 * a solid capture layer there would make the slide unclickable), so its wrapper is
 * `pointer-events-none` and only the strip inside it opts back in.
 *
 * Z-ORDER. Portaled onto `document.body`, these overlays order against it rather
 * than against the card, so the whole relation is written down once, bottom to top,
 * as `CANVAS_OVERLAY_Z` below: the palette at rest under the app's dialog/popover
 * layer (z-50) so its own popovers open above it, the picker over every canvas
 * overlay, and — only while picking — the palette lifted over the picker so the
 * pick highlight cannot paint across the strip. The reason for each step is on the
 * scale itself.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useCanvasStore } from '@/lib/store/canvas';

/**
 * The one place the canvas overlays' stacking is written down — one ordering,
 * bottom to top, with the app's own Radix layer (z-50, not ours) as a step in it:
 *
 * 1. `palette` (30) — where the insert strip rests. BELOW the Radix layer,
 *    because the strip's buttons are popovers that portal to `document.body` at
 *    that layer (`InsertButton`): any higher and the strip's own menus would open
 *    underneath it.
 * 2. the app's dialog/popover layer (z-50) — dialogs, popovers, tooltips.
 * 3. `picker` (120) — the element picker, above every canvas overlay including the
 *    resting palette: while picking, a click anywhere on the canvas has to mean
 *    "this element", not "insert one".
 * 4. `paletteOverPicker` (130) — where the insert strip goes WHILE picking, and
 *    only then, so the picker's violet ring and wash stop painting across the
 *    strip and washing it out to a disabled-looking grey. The strip is inert up
 *    here (see `FloatingInsertToolbar` for why, and for what stays clickable):
 *    it takes no pointer events, so clicks in its area fall through to the picker
 *    beneath and still mean "pick this element".
 */
export const CANVAS_OVERLAY_Z = {
  palette: 30,
  picker: 120,
  paletteOverPicker: 130,
} as const;

/** The canvas container these overlays live in and are clamped to. */
export const CANVAS_OVERLAY_FRAME_SELECTOR = '[data-maic-studio-frame]';

interface OverlayRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function sameRect(a: OverlayRect | null, b: OverlayRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/** Frames the rect must hold steady before the rAF loop parks itself. */
const STABLE_FRAMES_BEFORE_IDLE = 12;

/**
 * The live screen rect of the node the overlay is measured against — the closest
 * `measureSelector` ancestor of the anchor, or the anchor itself when none is
 * given (or none matches). Null while that node has no box at all (an unmounted
 * or `display:none` ancestor — a folded pane).
 */
function useAnchorRect(
  anchorRef: React.RefObject<HTMLElement | null>,
  measureSelector?: string,
): OverlayRect | null {
  const [rect, setRect] = useState<OverlayRect | null>(null);

  useEffect(() => {
    let raf = 0;
    let current: OverlayRect | null = null;
    let stableFrames = 0;
    let zoomActive = useCanvasStore.getState().zoomTarget !== null;

    const resolve = (): HTMLElement | null => {
      const anchor = anchorRef.current;
      if (!anchor) return null;
      if (!measureSelector) return anchor;
      // The frame is the target; fall back to the anchor if it is somehow absent
      // so the overlay degrades to card-local rather than vanishing.
      return anchor.closest<HTMLElement>(measureSelector) ?? anchor;
    };

    const read = (): OverlayRect | null => {
      const node = resolve();
      if (!node || !node.isConnected) return null;
      // `checkVisibility` is the honest hidden test (it walks display/visibility
      // on the ancestors); where the runtime lacks it, fall back to the box.
      if (typeof node.checkVisibility === 'function' && !node.checkVisibility()) return null;
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    };

    const measure = () => {
      const next = read();
      if (!sameRect(current, next)) {
        current = next;
        setRect(next);
        stableFrames = 0;
      } else {
        stableFrames += 1;
      }
      if (!zoomActive && stableFrames >= STABLE_FRAMES_BEFORE_IDLE) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(measure);
    };

    const arm = () => {
      stableFrames = 0;
      if (!raf) raf = requestAnimationFrame(measure);
    };

    // First read is synchronous so the overlay lands with the frame rather than a
    // frame later; the loop then follows whatever moves it.
    const first = read();
    current = first;
    setRect(first);
    arm();

    const observed = resolve();
    const observer =
      typeof ResizeObserver !== 'undefined' && observed ? new ResizeObserver(arm) : null;
    if (observer && observed) observer.observe(observed);
    window.addEventListener('scroll', arm, true);
    window.addEventListener('resize', arm);
    // A canvas zoom is an animated ancestor transform: keep following for its
    // whole duration, exactly as `useTrackedRect` does for element anchors.
    const unsubscribe = useCanvasStore.subscribe((state, prev) => {
      if (state.canvasScale !== prev.canvasScale || state.zoomTarget !== prev.zoomTarget) {
        zoomActive = state.zoomTarget !== null;
        arm();
      }
    });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
      unsubscribe();
      window.removeEventListener('scroll', arm, true);
      window.removeEventListener('resize', arm);
    };
  }, [anchorRef, measureSelector]);

  return rect;
}

export function CanvasOverlayPortal({
  zIndex,
  testId,
  measureSelector,
  capturePointer = false,
  children,
}: {
  /** From `CANVAS_OVERLAY_Z` — the scale is documented in one place. */
  readonly zIndex: number;
  readonly testId?: string;
  /**
   * The ancestor whose rect the portal box takes (and therefore what a child's
   * `absolute`/drag geometry is clamped to). Usually `CANVAS_OVERLAY_FRAME_SELECTOR`.
   * Omitted → the box is the anchor's own rect (the card).
   */
  readonly measureSelector?: string;
  /**
   * Let the portal's own box receive pointer events (the picker covers the
   * canvas). Default false: the box is `pointer-events-none` and only interactive
   * children opt back in, so it never blocks the slide underneath.
   */
  readonly capturePointer?: boolean;
  readonly children: ReactNode;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const rect = useAnchorRect(anchorRef, measureSelector);
  const canPortal = typeof document !== 'undefined';

  return (
    <>
      {/* The anchor: measured, never painted, and inside the card so it inherits
          the card's own visibility. An empty div paints nothing on its own, so it
          deliberately carries NO `invisible` / `opacity-0` — `checkVisibility()`
          would then be asked to judge exactly the properties that make this node
          inert, instead of the `display:none` ancestor it is here to detect. */}
      <div
        ref={anchorRef}
        aria-hidden="true"
        data-canvas-overlay-anchor={testId ?? ''}
        className="pointer-events-none absolute inset-0"
      />
      {canPortal && rect
        ? createPortal(
            <div
              data-testid={testId}
              style={{
                position: 'fixed',
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                zIndex,
                // Never block the slide underneath unless this overlay is meant
                // to capture the canvas (the picker). The palette re-enables
                // events on its strip alone.
                pointerEvents: capturePointer ? undefined : 'none',
              }}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
