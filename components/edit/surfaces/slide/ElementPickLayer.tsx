'use client';

/**
 * ElementPickLayer — canvas-side element picker, for both of its callers.
 *
 * Armed through `useCanvasStore.pickTarget` (see `PickTarget`), it covers the
 * slide canvas, outlines every selectable element and hit-tests the pointer
 * live. What a click MEANS is the target's `purpose`:
 *
 * - `cue` (timeline): bind this element to the armed scene action, then leave.
 *   Hovering previews the real playback effect (spotlight / laser) so the
 *   author sees what they are choosing.
 * - `element-ref` (dock lasso): toggle this element in the message's reference
 *   list and STAY armed — multi-pick is the point. Already-referenced elements
 *   wear their pin number, and clicking one un-picks it. No cue preview: the
 *   elements are being named, not animated.
 *
 * Empty-canvas click cancels in `cue` mode (there is one thing to choose and
 * clicking past it means "never mind"); in `element-ref` mode it does nothing,
 * because losing a five-element selection to a stray click is not a cancel the
 * user asked for. Esc always leaves.
 *
 * The canvas itself stays as the author wrote it. Pick mode used to outline EVERY
 * selectable element with a faint ring and wash, on the theory that an author
 * cannot tell what is clickable — the cost was a slide covered in violet boxes,
 * which is a worse answer to "what am I about to pick" than the pointer's own
 * hover ring. So: one ring on the element under the pointer, the numbered pins on
 * the ones already staged (`ElementRefPinLayer`), and nothing else.
 *
 * A floating element panel (draggable + collapsible) lists the page's elements
 * for the same two actions, for elements too small to hit or hidden behind
 * another. Hovering a row rings the element on the canvas — the same single ring,
 * driven by the same `hover` state, which is why the panel still works with the
 * all-elements outlining gone.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, GripHorizontal, MousePointerClick } from 'lucide-react';
import { useCanvasStore } from '@/lib/store/canvas';
import { useElementRefsForSession, useElementRefsStore } from '@/lib/store/element-refs';
import { useStageStore } from '@/lib/store/stage';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { setElementIdById } from '@/components/edit/ActionsBar/actions-edit';
import { cueLabel } from '@/components/edit/ActionsBar/cue-meta';
import { clearCuePreview, previewCueEffect } from '@/components/edit/ActionsBar/cue-preview';
import {
  MAX_ELEMENT_REFS,
  elementRefLabel,
  elementRefOrdinal,
  makeElementRef,
  type SlideElementLike,
} from '@/lib/workbench/element-refs';
import { elementIdAtPoint, measureElementBox, type CanvasBox } from './element-hit-test';
import {
  CANVAS_OVERLAY_FRAME_SELECTOR,
  CANVAS_OVERLAY_Z,
  CanvasOverlayPortal,
} from './CanvasOverlayPortal';

const PANEL_W = 232;
/** Margin kept between the panel and its container on every side. */
const PANEL_MARGIN = 8;
/** Height assumed for the panel while its DOM node is not yet measurable (the header strip). */
const PANEL_FALLBACK_HEIGHT = 40;

export interface PanelPosition {
  x: number;
  y: number;
}

export interface PanelSize {
  width: number;
  height: number;
}

/**
 * Clamp a floating panel's top-left corner inside its container so the WHOLE
 * panel stays visible, not just its drag handle: on each axis the position is
 * pinned to `[PANEL_MARGIN, container − panel − PANEL_MARGIN]`. When the panel
 * is larger than the container (a long list in a short frame) the upper bound
 * collapses and the panel pins to the top-left margin instead of hanging past
 * the bottom/right edge. The drag path and the re-clamp path both call this, so
 * the boundary rule lives in exactly one place.
 */
export function clampPanelPosition(
  pos: PanelPosition,
  containerSize: PanelSize,
  panelSize: PanelSize,
): PanelPosition {
  const maxX = Math.max(PANEL_MARGIN, containerSize.width - panelSize.width - PANEL_MARGIN);
  const maxY = Math.max(PANEL_MARGIN, containerSize.height - panelSize.height - PANEL_MARGIN);
  return {
    x: Math.min(Math.max(PANEL_MARGIN, pos.x), maxX),
    y: Math.min(Math.max(PANEL_MARGIN, pos.y), maxY),
  };
}

/**
 * A canvas element as this layer needs it: everything `elementRefLabel` reads
 * (per-type text lives on different fields), plus a definite `id` — an element
 * with no id cannot be picked, measured or referenced.
 */
type PickableElement = SlideElementLike & { id: string };

export function ElementPickLayer() {
  const { t } = useI18n();
  const pickTarget = useCanvasStore.use.pickTarget();
  const sessionId = useWorkbenchStore((s) => s.sessionId);
  const currentStageId = useStageStore((s) => s.stage?.id ?? null);
  const currentSceneId = useStageStore.use.currentSceneId();
  // Reactive scene lookup so the panel/binding state tracks store updates.
  const scene = useStageStore((s) =>
    pickTarget && s.stage?.id === pickTarget.stageId && s.currentSceneId === pickTarget.sceneId
      ? (s.scenes.find((x) => x.id === pickTarget.sceneId) ?? null)
      : null,
  );
  const refs = useElementRefsForSession(sessionId);

  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ id: string; box: CanvasBox } | null>(null);
  const [panel, setPanel] = useState<{ x: number; y: number }>({ x: 0, y: 16 });
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const moveRafRef = useRef<number | null>(null);

  const purpose = pickTarget?.purpose;
  const cueType = pickTarget?.purpose === 'cue' ? pickTarget.cueType : undefined;
  const elements = useMemo<PickableElement[]>(
    () =>
      (
        (scene?.content as { canvas?: { elements?: SlideElementLike[] } } | undefined)?.canvas
          ?.elements ?? []
      ).filter((element): element is PickableElement => typeof element.id === 'string'),
    [scene],
  );
  const currentBound =
    pickTarget?.purpose === 'cue'
      ? ((
          scene?.actions?.find((a) => a.id === pickTarget.actionId) as
            | { elementId?: string }
            | undefined
        )?.elementId ?? '')
      : '';

  const preview = useCallback(
    (elementId: string) => {
      if (cueType) previewCueEffect(cueType, elementId);
    },
    [cueType],
  );

  const finish = useCallback(() => {
    clearCuePreview();
    useCanvasStore.getState().setPickTarget(null);
    setHover(null);
  }, []);

  /**
   * A pick. In `cue` mode it binds by `actionId` (index-stale-safe against a
   * concurrent reorder/delete) and ends the mode; in `element-ref` mode it
   * toggles the element in the staged list and keeps the layer armed.
   */
  const pick = useCallback(
    (elementId: string) => {
      const pt = useCanvasStore.getState().pickTarget;
      if (!pt) return;
      if (pt.purpose === 'element-ref') {
        const currentSessionId = useWorkbenchStore.getState().sessionId;
        const refsState = useElementRefsStore.getState();
        // The pick may target a course other than the session's bound one: refs
        // carry their own stageId and the runner resolves against that (the
        // open-domain tool surface has no mutable "active stage"), so the only
        // fences are the chat that owns the draft and the course on screen.
        if (
          !currentSessionId ||
          pt.ownerSessionId !== currentSessionId ||
          refsState.ownerSessionId !== currentSessionId
        ) {
          finish();
          return;
        }
        const stageState = useStageStore.getState();
        if (stageState.stage?.id !== pt.stageId) {
          finish();
          return;
        }
        const sc = stageState.scenes.find((s) => s.id === pt.sceneId);
        const element = (
          sc?.content as { canvas?: { elements?: SlideElementLike[] } } | undefined
        )?.canvas?.elements?.find((el) => el.id === elementId);
        if (!element) return;
        const ref = makeElementRef(pt.stageId, pt.sceneId, element, t);
        if (ref) refsState.toggle(ref);
        return;
      }
      const stageState = useStageStore.getState();
      if (stageState.stage?.id !== pt.stageId) {
        finish();
        return;
      }
      const sc = stageState.scenes.find((s) => s.id === pt.sceneId);
      if (sc) {
        useStageStore.getState().updateScene(pt.sceneId, {
          actions: setElementIdById(sc.actions ?? [], pt.actionId, elementId),
        });
      }
      finish();
    },
    [finish, t],
  );

  // The target is UI state owned by one exact course page. Clear every visual
  // side effect as soon as navigation makes either half of that identity stale;
  // merely rendering null would leave shortcuts disabled and pins suppressed.
  // For `element-ref`, identity is (chat, DISPLAYED course, page) — never the
  // session's bound stage: the open-domain tool surface has no mutable "active
  // stage" pointer, element refs carry their own stageId, and the runner
  // resolves them against the course they name. So a pick may point at a course
  // other than the one the chat session is bound to.
  useLayoutEffect(() => {
    if (
      !pickTarget ||
      (pickTarget.stageId === currentStageId &&
        pickTarget.sceneId === currentSceneId &&
        (pickTarget.purpose !== 'element-ref' || pickTarget.ownerSessionId === sessionId))
    ) {
      return;
    }
    if (moveRafRef.current != null) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = null;
    }
    clearCuePreview();
    useCanvasStore.getState().setPickTarget(null);
    setHover(null);
  }, [currentSceneId, currentStageId, pickTarget, sessionId]);

  /**
   * Re-measure the hovered element's ring. The ring is a box in canvas
   * coordinates, so anything that moves the canvas under a still pointer (a
   * window resize, a scroll in an ancestor) leaves it pointing at where the
   * element WAS. Nothing else is measured up front any more: with the
   * all-elements outlining gone there is exactly one box on screen.
   */
  const remeasureHover = useCallback(() => {
    setHover((current) => {
      if (!current) return current;
      const box = measureElementBox(current.id, rootRef.current);
      return box ? { id: current.id, box } : null;
    });
  }, []);

  /**
   * Pull the panel back inside the container. The drag clamps against the
   * panel's CURRENT size, so a panel whose height changes under it (expanding a
   * collapsed panel that was dragged to the bottom, a longer element list, a
   * resized container) can end up overhanging the frame; this re-applies the
   * same pure clamp the drag uses, so the two paths cannot drift apart.
   */
  const reclampPanel = useCallback(() => {
    const cr = rootRef.current?.getBoundingClientRect();
    if (!cr) return;
    const panelH = panelRef.current?.offsetHeight ?? PANEL_FALLBACK_HEIGHT;
    setPanel((prev) => clampPanelPosition(prev, cr, { width: PANEL_W, height: panelH }));
  }, []);

  // On entering pick mode: dock the element panel top-right.
  useEffect(() => {
    if (!pickTarget) return;
    const cr = rootRef.current?.getBoundingClientRect();
    if (cr) setPanel({ x: Math.max(8, cr.width - PANEL_W - 16), y: 16 });
    setCollapsed(false);
    const onResize = () => {
      remeasureHover();
      reclampPanel();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickTarget?.sceneId, purpose, elements.length, reclampPanel]);

  /**
   * The portaled container (`rootRef`) only exists once `CanvasOverlayPortal`
   * has measured the frame rect — a render AFTER this layer first arms — so a
   * ref callback is the mount signal: `containerReady` flips true exactly when
   * the node the panel clamps to is in the DOM.
   */
  const [containerReady, setContainerReady] = useState(false);
  const attachContainerRef = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    if (node) setContainerReady(true);
  }, []);

  // Re-clamp on in-frame container resizes: dragging the edit dock's handle up
  // shrinks the studio frame from below, and the workspace divider drags
  // re-shape it — neither fires a window resize, but the portaled box tracks
  // them via `CanvasOverlayPortal`'s rAF rect loop, so `rootRef` (which fills
  // the box) resizes in place. The observer fires for exactly those changes
  // and pulls the panel back inside (the real-browser repro: a taller timeline
  // pushed the panel over the dock). `reclampPanel` is idempotent, so the
  // window-resize path keeping it too is harmless.
  useEffect(() => {
    if (!pickTarget || !containerReady) return;
    const observed = rootRef.current;
    if (!observed || typeof ResizeObserver === 'undefined') return;
    const frameObserver = new ResizeObserver(() => reclampPanel());
    frameObserver.observe(observed);
    return () => frameObserver.disconnect();
  }, [pickTarget, containerReady, reclampPanel]);

  // Re-clamp when the panel's own size changes under a position that was
  // clamped against the old one: a collapsed panel dragged to the bottom grows
  // on expand, and a longer element list does the same. Container resizes are
  // covered by the entry effect above (window resize listener + the
  // ResizeObserver on the container).
  useEffect(() => {
    if (!pickTarget) return;
    reclampPanel();
  }, [collapsed, elements.length, pickTarget, reclampPanel]);

  useEffect(() => {
    if (!pickTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickTarget, finish]);

  // Unmount cleanup: cancel any pending rAF, and — if this layer unmounts while
  // still armed (scene switch / leaving the slide surface before the user picks)
  // — clear the global pick target + preview. pickTarget lives in the canvas
  // store, so without this it survives the unmount and the next slide mount
  // renders a stale picker bound to the old scene/action. A normal finish()
  // already nulled pickTarget, so this is a no-op in that case.
  useEffect(
    () => () => {
      if (moveRafRef.current != null) cancelAnimationFrame(moveRafRef.current);
      if (useCanvasStore.getState().pickTarget) {
        clearCuePreview();
        useCanvasStore.getState().setPickTarget(null);
      }
    },
    [],
  );

  if (!pickTarget) return null;
  // The owner fence is the only render condition: cross-course picks (displayed
  // course ≠ session-bound course) are valid, refs self-describe their stage.
  if (pickTarget.purpose === 'element-ref' && pickTarget.ownerSessionId !== sessionId) return null;
  if (!scene) return null;

  const isRefMode = pickTarget.purpose === 'element-ref';
  const sceneId = pickTarget.sceneId;
  const atCap = isRefMode && refs.length >= MAX_ELEMENT_REFS;
  const banner = isRefMode
    ? {
        lead: t('edit.pick.refLead', { count: refs.length, max: MAX_ELEMENT_REFS }),
        hint: atCap ? t('edit.pick.refCapHint') : t('edit.pick.refHint'),
      }
    : {
        lead: t('edit.pick.pickFor', { label: cueLabel(pickTarget.cueType, t) }),
        hint: t('edit.pick.pickHint'),
      };

  // Hit-test on mousemove, coalesced to one rAF per frame.
  const onCanvasMove = (e: React.MouseEvent) => {
    const { clientX, clientY } = e;
    if (moveRafRef.current != null) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null;
      const id = elementIdAtPoint(clientX, clientY);
      if (!id) {
        if (hover) {
          setHover(null);
          preview('');
        }
        return;
      }
      if (id !== hover?.id) {
        const box = measureElementBox(id, rootRef.current);
        setHover(box ? { id, box } : null);
        preview(id);
      }
    });
  };

  const onCanvasClick = () => {
    if (hover) pick(hover.id);
    // Clicking past every element: a cue pick is a single choice, so this reads
    // as "never mind". A multi-pick selection must not evaporate the same way.
    else if (!isRefMode) finish();
  };

  const highlightById = (id: string) => {
    const box = measureElementBox(id, rootRef.current);
    setHover(box ? { id, box } : { id, box: { left: 0, top: 0, width: 0, height: 0 } });
    preview(id);
  };

  const onPanelDown = (e: React.PointerEvent) => {
    dragRef.current = { px: e.clientX, py: e.clientY, ox: panel.x, oy: panel.y };
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* best effort */
    }
  };
  const onPanelMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const next = { x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) };
    const cr = rootRef.current?.getBoundingClientRect();
    if (!cr) {
      setPanel(next);
      return;
    }
    // Clamp against the panel's ACTUAL height — the old `height - 40` only kept
    // the handle's top inside the frame, letting a tall list hang below it.
    const panelH = panelRef.current?.offsetHeight ?? PANEL_FALLBACK_HEIGHT;
    setPanel(clampPanelPosition(next, cr, { width: PANEL_W, height: panelH }));
  };
  const onPanelUp = () => {
    dragRef.current = null;
  };

  return (
    // Portaled onto the STUDIO FRAME (the padded canvas container), so the panel
    // is never clipped by the card's `overflow-hidden` and can roam the grey
    // padding around the card without escaping to the dock. The box IS the
    // frame's, and everything in here measures relative to `rootRef` (which fills
    // it), so element rings and hit-tests land at the same screen point as before.
    // `capturePointer`: pick mode deliberately covers the whole canvas — a click
    // anywhere means "this element", or "never mind" on the empty padding.
    <CanvasOverlayPortal
      zIndex={CANVAS_OVERLAY_Z.picker}
      testId="element-pick-layer"
      measureSelector={CANVAS_OVERLAY_FRAME_SELECTOR}
      capturePointer
    >
      <div ref={attachContainerRef} className="absolute inset-0">
        {/* click-catcher (sibling of the panel, so panel clicks never reach it) */}
        <div
          className="absolute inset-0 cursor-crosshair"
          onMouseMove={onCanvasMove}
          onClick={onCanvasClick}
        />

        {/* hovered element — the one ring on the canvas */}
        {hover && hover.box.width > 0 && (
          <div
            className="pointer-events-none absolute rounded-md bg-violet-500/[0.06] ring-2 ring-violet-500"
            style={{
              left: hover.box.left - 2,
              top: hover.box.top - 2,
              width: hover.box.width + 4,
              height: hover.box.height + 4,
            }}
          />
        )}

        {/* instruction banner */}
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-violet-300/60 bg-popover/95 px-3.5 py-1.5 text-[12px] font-medium text-foreground shadow-lg shadow-black/10 backdrop-blur">
          <span className="text-violet-600 dark:text-violet-400">{banner.lead}</span> ·{' '}
          {banner.hint}
        </div>

        {/* draggable + collapsible element panel, inside the canvas */}
        <div
          ref={panelRef}
          onClick={(e) => e.stopPropagation()}
          style={{ left: panel.x, top: panel.y, width: PANEL_W }}
          className="absolute flex max-h-[70%] flex-col overflow-hidden rounded-2xl border border-border bg-popover/95 shadow-xl shadow-black/15 backdrop-blur"
        >
          <div
            onPointerDown={onPanelDown}
            onPointerMove={onPanelMove}
            onPointerUp={onPanelUp}
            onPointerCancel={onPanelUp}
            className="flex cursor-grab touch-none items-center gap-1.5 border-b border-border px-2.5 py-2 active:cursor-grabbing"
          >
            <GripHorizontal className="size-3.5 text-muted-foreground/40" />
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
              {t('edit.pick.pageElements', { count: elements.length })}
            </span>
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className="ml-auto grid size-5 place-items-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
              aria-label={collapsed ? t('edit.pick.expand') : t('edit.pick.collapse')}
            >
              <ChevronDown
                className={`size-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`}
              />
            </button>
          </div>

          {!collapsed && (
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {elements.length === 0 ? (
                <p className="px-2 py-3 text-[11px] text-muted-foreground/70">
                  {t('edit.pick.noElements')}
                </p>
              ) : (
                elements.map((el) => {
                  const ordinal = isRefMode
                    ? elementRefOrdinal(refs, pickTarget.stageId, sceneId, el.id)
                    : 0;
                  const marked = isRefMode ? ordinal > 0 : el.id === currentBound;
                  return (
                    <button
                      key={el.id}
                      type="button"
                      onMouseEnter={() => highlightById(el.id)}
                      onMouseLeave={() => {
                        setHover(null);
                        preview('');
                      }}
                      onClick={() => pick(el.id)}
                      disabled={isRefMode && atCap && ordinal === 0}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent ${
                        marked
                          ? 'bg-violet-50 ring-1 ring-violet-200 dark:bg-violet-500/10 dark:ring-violet-500/30'
                          : ''
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-foreground/90">
                        {elementRefLabel(el, t)}
                      </span>
                      {ordinal > 0 ? (
                        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-violet-500 text-[9px] font-semibold tabular-nums text-white">
                          {ordinal}
                        </span>
                      ) : marked ? (
                        <Check className="size-3 shrink-0 text-violet-500" />
                      ) : (
                        <span className="shrink-0 font-mono text-[9px] text-muted-foreground/45">
                          {el.id.slice(0, 6)}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          )}

          {collapsed && (
            <div className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] text-muted-foreground/50">
              <MousePointerClick className="size-3" />{' '}
              {isRefMode ? t('edit.pick.refHint') : t('edit.pick.bindHint')}
            </div>
          )}
        </div>
      </div>
    </CanvasOverlayPortal>
  );
}
