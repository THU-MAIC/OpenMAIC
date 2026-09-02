'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, Reorder, motion, useReducedMotion } from 'motion/react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useBrand, useIsDesktop } from '@/lib/brand/brand-context';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useDeletedSceneRecycle } from '@/lib/edit/deleted-scene-recycle';
import { duplicateSlideScene } from '@/lib/edit/slide-defaults';
import {
  createBlankEditableScene,
  insertSceneAtIndex,
  type EditableSceneType,
} from '@/lib/edit/scene-defaults';
import { SCENE_CREATION_ENABLED } from '@/lib/edit/scene-creation-enabled';
import { CHROME_DURATION_MS, CHROME_EASE, CHROME_EASE_CSS } from '@/lib/edit/transitions';
import { useInWorkbenchPanel } from '@/lib/workbench/panel-context';
import type { Scene } from '@/lib/types/stage';
import { ThumbItem } from './ThumbItem';
import { InsertionZone } from './InsertionZone';

// Collapsed, the rail is a slim edge handle — just wide enough to hold the
// expand chevron — rather than a narrow column of page numbers. The point of
// collapsing is to give the horizontal space back to the canvas, so it keeps
// almost none; the handle is the only thing that survives, so the rail can be
// brought back.
const RAIL_HANDLE_PX = 16;
const RAIL_MIN_PX = 180;
const RAIL_MAX_PX = 360;

/**
 * Pro mode slide-navigation left rail (Studio Editor aesthetic).
 *
 * Layout: a vertical thumbnail strip with monospaced index captions
 * below each tile, inter-thumb "+" insertion zones revealed on hover,
 * and a collapse chevron on the rail/slide boundary. All scene types are
 * first-class — slides render a live `ThumbnailSlide`, non-slide scenes
 * get a type-icon stub but stay clickable, draggable, and right-clickable
 * so page-level management is uniform across the deck.
 *
 * Visuals: low-chroma zinc surface + single violet brand accent, no
 * per-row chrome (rejected `EditModeSidebar` pattern). Drag uses an
 * explicit grip handle on the thumb so the whole tile remains
 * click-to-switch.
 */
export function SlideNavRail() {
  const { t } = useI18n();
  const router = useRouter();
  const brand = useBrand();
  const isDesktop = useIsDesktop();
  const inWorkbenchPanel = useInWorkbenchPanel();
  const scenes = useStageStore.use.scenes();
  const currentSceneId = useStageStore.use.currentSceneId();
  const setCurrentSceneId = useStageStore.use.setCurrentSceneId();
  const setScenes = useStageStore.use.setScenes();
  const insertSceneAfter = useStageStore.use.insertSceneAfter();
  const deleteScene = useStageStore.use.deleteScene();
  const stage = useStageStore.use.stage();
  const collapsed = useSettingsStore((s) => s.editRailCollapsed);
  const setCollapsed = useSettingsStore((s) => s.setEditRailCollapsed);
  const persistedWidth = useSettingsStore((s) => s.editRailWidth);
  const setPersistedWidth = useSettingsStore((s) => s.setEditRailWidth);
  const prefersReducedMotion = useReducedMotion();

  // Drag-to-resize.
  //
  // We mutate the rail's `style.width` directly on the DOM during pointer
  // move (bypassing React entirely) and only commit the final width to the
  // settings store on pointer-up. This is what makes the handle feel glued
  // to the cursor: there's no React render → reconcile → DOM commit
  // latency between move events and the visible width change.
  //
  // Pointer Events (with `setPointerCapture` on the handle) replace the
  // older `document` mousemove/mouseup binding. With capture, the handle
  // receives `pointerup` / `pointercancel` even if the cursor leaves the
  // window, the OS reclaims focus, or a tab switch interrupts the gesture
  // — none of which fire `document` mouseup, which previously left the
  // rail stuck in a "drag is still in progress" state until remount.
  //
  // `isDragging` is still React state so we can turn off the CSS
  // `transition: width` for the duration of the gesture — otherwise the
  // 280ms tween from the collapse/expand animation would fight every
  // direct width write.
  const railRef = useRef<HTMLElement>(null);
  const dragStateRef = useRef<{
    startX: number;
    startWidth: number;
    lastWidth: number;
    pointerId: number;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const cleanupDrag = useCallback(() => {
    dragStateRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    setIsDragging(false);
  }, []);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) return;
      // Only primary button; ignore right-click / middle-click.
      if (e.button !== 0) return;
      e.preventDefault();
      const target = e.currentTarget;
      // Pointer capture guarantees this element receives pointermove /
      // pointerup / pointercancel for the duration of the gesture, even
      // when the cursor leaves the window.
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // Spec-wise `setPointerCapture` can only throw `InvalidPointerId`,
        // which shouldn't happen inside the same pointer's `pointerdown`.
        // This catch is paranoia, NOT a real fallback: if capture
        // genuinely fails the gesture still tracks for in-window moves
        // but `pointerup` outside the handle's bbox won't route here and
        // the rail will stay in `isDragging` until SlideNavRail
        // unmounts. The pointermove path remains useful so dropping the
        // throw on the floor is preferable to bailing the gesture.
      }
      dragStateRef.current = {
        startX: e.clientX,
        startWidth: persistedWidth,
        lastWidth: persistedWidth,
        pointerId: e.pointerId,
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      setIsDragging(true);
    },
    [collapsed, persistedWidth],
  );

  const handleResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const delta = e.clientX - drag.startX;
    const next = Math.min(RAIL_MAX_PX, Math.max(RAIL_MIN_PX, drag.startWidth + delta));
    drag.lastWidth = next;
    if (railRef.current) railRef.current.style.width = `${next}px`;
  }, []);

  const handleResizeEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Capture may already have been released by a pointercancel.
      }
      // Commit final width to persisted settings exactly once per gesture.
      // React will re-render with `style.width = persistedWidth`, which
      // matches the DOM value we already wrote — no visual jump.
      setPersistedWidth(drag.lastWidth);
      cleanupDrag();
    },
    [cleanupDrag, setPersistedWidth],
  );

  useEffect(
    () => () => {
      // Belt and suspenders: clear any document-level overrides on unmount.
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    },
    [],
  );

  const slideCount = useMemo(() => scenes.filter((s) => s.type === 'slide').length, [scenes]);
  // For non-slide scenes (no recreate path), only allow delete if there's
  // more than one scene overall — otherwise the deck would become empty.
  const totalScenes = scenes.length;

  const onReorderIds = useCallback(
    (newOrder: string[]) => {
      const byId = new Map(scenes.map((s) => [s.id, s] as const));
      const next: Scene[] = newOrder
        .map((id) => byId.get(id))
        .filter((s): s is Scene => Boolean(s));
      if (next.length !== scenes.length) return;
      const rebalanced = next.map((s, i) => (s.order === i + 1 ? s : { ...s, order: i + 1 }));
      setScenes(rebalanced);
    },
    [scenes, setScenes],
  );

  const handleActivate = useCallback(
    (sceneId: string) => {
      if (sceneId === currentSceneId) return;
      // Switching to a non-slide scene is fine — Stage will auto-exit Pro
      // mode the moment the new scene is uneditable.
      setCurrentSceneId(sceneId);
    },
    [currentSceneId, setCurrentSceneId],
  );

  const handleInsertAt = useCallback(
    (insertIndex: number, type: EditableSceneType) => {
      if (!stage) return;
      const title = type === 'slide' ? t('edit.nav.untitledSlide') : t('edit.sceneType.quiz');
      const scene = createBlankEditableScene(type, stage.id, title, insertIndex + 1);
      setScenes(insertSceneAtIndex(scenes, scene, insertIndex));
      setCurrentSceneId(scene.id);
    },
    [scenes, setCurrentSceneId, setScenes, stage, t],
  );

  const handleDuplicate = useCallback(
    (sceneId: string) => {
      const source = scenes.find((s) => s.id === sceneId);
      if (!source) return;
      const anchorIndex = scenes.findIndex((s) => s.id === sceneId);
      const newOrder = anchorIndex + 2;
      // Slide scenes get a deep clone with reseeded element IDs; non-slide
      // scenes just get a shallow id + title bump.
      const copy: Scene =
        source.type === 'slide'
          ? duplicateSlideScene(source, t('edit.nav.copySuffix'), newOrder)
          : {
              ...source,
              id: crypto.randomUUID(),
              title: `${source.title} ${t('edit.nav.copySuffix')}`,
              order: newOrder,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
      insertSceneAfter(sceneId, copy);
      setCurrentSceneId(copy.id);
    },
    [insertSceneAfter, scenes, setCurrentSceneId, t],
  );

  const handleDelete = useCallback(
    (sceneId: string) => {
      const source = scenes.find((s) => s.id === sceneId);
      if (!source) return;
      // Hold deck-empty guard at the rail layer; the store doesn't enforce.
      if (source.type === 'slide' && slideCount <= 1) return;
      if (totalScenes <= 1) return;
      const index = scenes.findIndex((s) => s.id === sceneId);
      useDeletedSceneRecycle.getState().capture(source, index);
      deleteScene(sceneId);
      toast(t('edit.nav.deleted'), {
        description: source.title,
        duration: 5000,
        action: {
          label: t('edit.nav.undo'),
          onClick: () => {
            const entry = useDeletedSceneRecycle.getState().consume();
            if (!entry) return;
            // Stage-scope guard: if the user has navigated to a
            // different stage while the toast was up, the recycle
            // entry belongs to the previous stage and `insertSceneAfter`
            // would reject it on stage-id mismatch (silently losing the
            // deleted scene). Drop the undo when stages don't match
            // rather than blasting the entry into the wrong deck.
            const currentStage = useStageStore.getState().stage;
            if (!currentStage || currentStage.id !== entry.stageId) return;
            const live = useStageStore.getState().scenes;
            // Prepend path — `insertSceneAfter` requires an anchor, but
            // restoring index 0 (the previously-first slide) has no
            // predecessor to anchor on. Clamping `entry.index - 1` to 0
            // and inserting after `live[0]` would land the entry at
            // position 1 instead of 0. setScenes-with-rebalance
            // preserves the original "first slide" semantics.
            if (entry.index === 0 || live.length === 0) {
              useStageStore.getState().setScenes([entry.scene, ...live]);
              useStageStore.getState().setCurrentSceneId(entry.scene.id);
              return;
            }
            const anchorIndex = Math.min(entry.index - 1, live.length - 1);
            const anchor = live[anchorIndex];
            useStageStore.getState().insertSceneAfter(anchor.id, entry.scene);
            useStageStore.getState().setCurrentSceneId(entry.scene.id);
          },
        },
        onDismiss: () => useDeletedSceneRecycle.getState().clear(),
        onAutoClose: () => useDeletedSceneRecycle.getState().clear(),
      });
    },
    [deleteScene, scenes, slideCount, totalScenes, t],
  );

  const canDeleteAny = totalScenes > 1;
  const canDeleteSlide = slideCount > 1;

  // Plain CSS transition mirrors playback `SceneSidebar` exactly: zero
  // motion.dev overhead, instant width updates while dragging. The earlier
  // `motion.aside animate={false}` still ran motion's element-tracking
  // pipeline per frame even with animation off, which produced the
  // perceptible drag lag the user reported.
  const widthTransitionCss = isDragging
    ? 'none'
    : prefersReducedMotion
      ? 'none'
      : `width ${CHROME_DURATION_MS}ms ${CHROME_EASE_CSS}`;

  return (
    <aside
      ref={railRef}
      data-testid="slide-nav-rail"
      data-collapsed={collapsed}
      // Mirrors playback SceneSidebar: white/translucent surface, soft
      // right border, backdrop blur. `overflow-hidden` clips tiles to
      // the rail's current width — without it, mid-drag widths leak
      // children rightward (the inner scroll body has overflow-x-hidden
      // but it sits inside this aside and only clips its own
      // descendants, not the aside's edge).
      //
      // Width is React-driven only outside drag gestures. During a drag,
      // `handleResizeStart` writes `style.width` directly on this element
      // for instant, cursor-locked tracking; React's render value would
      // arrive too late.
      className={cn(
        'relative flex h-full shrink-0 flex-col overflow-hidden',
        'border-r border-gray-100 dark:border-gray-800',
        'bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl',
        'shadow-[2px_0_24px_rgba(0,0,0,0.02)]',
      )}
      style={{
        width: collapsed ? RAIL_HANDLE_PX : persistedWidth,
        transition: widthTransitionCss,
      }}
    >
      {/* Resize handle — right edge, 6px hit zone, only enabled when
          expanded. Pointer Events with capture: once the gesture starts
          this element owns the move/up/cancel stream regardless of
          cursor location, so the rail can't get stuck in a "still
          dragging" state on alt-tab / window blur / cursor-leaves-
          window. */}
      {!collapsed && (
        <div
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          className="group absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize touch-none hover:bg-violet-400/30 dark:hover:bg-violet-500/30 active:bg-violet-500/50 transition-colors"
        >
          <div className="absolute right-0.5 top-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-gray-300 dark:bg-gray-600 group-hover:bg-violet-400 dark:group-hover:bg-violet-500 transition-colors" />
        </div>
      )}
      {/* Collapse / expand control. Two forms of one toggle (stable testid):
          - EXPANDED: a faint chevron on the rail/slide boundary, one register
            lighter than a pane seam because this is a boundary inside a pane.
          - COLLAPSED: the whole slim handle IS the control — a full-height edge
            strip with a centred chevron — so the rail that gave its width back to
            the canvas is still easy to find and bring back. */}
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label={t('edit.nav.expand')}
          title={t('edit.nav.expand')}
          data-testid="slide-nav-rail-collapse"
          className={cn(
            'absolute inset-0 z-10 flex items-center justify-center',
            'text-zinc-400/70 dark:text-zinc-500/70',
            'hover:bg-gray-100/80 hover:text-zinc-600 dark:hover:bg-gray-800/80 dark:hover:text-zinc-300',
            'focus-visible:outline-none focus-visible:bg-gray-100/80 focus-visible:text-zinc-600 focus-visible:ring-1 focus-visible:ring-violet-400/50 dark:focus-visible:bg-gray-800/80 dark:focus-visible:text-zinc-300',
            'active:bg-gray-200/90 active:text-zinc-700 dark:active:bg-gray-700/90 dark:active:text-zinc-200',
            'transition-colors duration-150',
          )}
        >
          <ChevronRight className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label={t('edit.nav.collapse')}
          title={t('edit.nav.collapse')}
          data-testid="slide-nav-rail-collapse"
          className={cn(
            'absolute right-0 top-1/2 z-10 flex h-8 w-6 -translate-y-1/2 items-center justify-center rounded-l-md',
            'text-zinc-400/70 dark:text-zinc-500/70',
            'hover:bg-gray-100/80 hover:text-zinc-600 dark:hover:bg-gray-800/80 dark:hover:text-zinc-300',
            'focus-visible:outline-none focus-visible:bg-gray-100/80 focus-visible:text-zinc-600 focus-visible:ring-1 focus-visible:ring-violet-400/50 dark:focus-visible:bg-gray-800/80 dark:focus-visible:text-zinc-300',
            'active:bg-gray-200/90 active:text-zinc-700 dark:active:bg-gray-700/90 dark:active:text-zinc-200',
            'transition-colors duration-150',
          )}
        >
          <ChevronLeft className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}

      {/* Header band — mirrors playback `SceneSidebar`: OpenMAIC logo on
          the left (click → home). Height (h-10 + mt-3 + mb-1 = ~56px)
          matches playback so the chrome top edge stays at the same screen
          pixel across the mode swap. Inside the workbench panel the band
          is dropped entirely — its only other occupant, the collapse
          control, now lives on the rail/slide boundary — so the first
          thumbnail starts on the same 12px rhythm as the canvas. */}
      {!inWorkbenchPanel && !collapsed && (
        <div className="shrink-0 px-3 mt-3 mb-1 h-10 flex items-center">
          {!collapsed && !isDesktop && (
            <button
              type="button"
              onClick={() => router.push('/')}
              title={t('generation.backToHome')}
              className="flex items-center gap-2 cursor-pointer rounded-lg px-1.5 -mx-1.5 py-1 -my-1 hover:bg-gray-100/80 dark:hover:bg-gray-800/60 active:scale-[0.97] transition-all duration-150"
            >
              {/* Desktop client: the Electron title bar already shows the brand icon + name, so the edit rail doesn't repeat it;
                  returning home is handled by the edit bar's CommandBar back arrow. */}
              <img src={brand.logoSrc} alt={brand.productName} className="h-6 w-auto" />
            </button>
          )}
        </div>
      )}

      {/* Body — list padding (p-2 space-y-2) matches playback's scene
          list so spacing/density read the same. Collapsed, there is no body at
          all: the slim handle above is the whole rail. */}
      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide pt-1">
          <AnimatePresence initial={false}>
            <motion.div
              key="expanded-list"
              initial={prefersReducedMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.18, ease: CHROME_EASE }}
              className="p-2"
            >
              <Reorder.Group
                axis="y"
                values={scenes.map((s) => s.id)}
                onReorder={onReorderIds}
                as="ol"
                className="m-0 list-none p-0"
              >
                {/* Leading zone — hover the top padding to insert
                    before the first thumb. Hits the `+ at top` use
                    case the user called out. */}
                {SCENE_CREATION_ENABLED && scenes[0] ? (
                  <InsertionZone
                    label={t('edit.nav.addPage')}
                    slideLabel={t('edit.sceneType.slide')}
                    quizLabel={t('edit.sceneType.quiz')}
                    onInsert={(type) => handleInsertAt(0, type)}
                  />
                ) : null}
                {scenes.map((scene, index) => (
                  <Fragment key={scene.id}>
                    <ThumbItem
                      scene={scene}
                      index={index}
                      active={scene.id === currentSceneId}
                      canDelete={scene.type === 'slide' ? canDeleteSlide : canDeleteAny}
                      onActivate={() => handleActivate(scene.id)}
                      onDuplicate={() => handleDuplicate(scene.id)}
                      onDelete={() => handleDelete(scene.id)}
                    />
                    {SCENE_CREATION_ENABLED && (
                      <InsertionZone
                        label={t('edit.nav.addPage')}
                        slideLabel={t('edit.sceneType.slide')}
                        quizLabel={t('edit.sceneType.quiz')}
                        onInsert={(type) => handleInsertAt(index + 1, type)}
                      />
                    )}
                  </Fragment>
                ))}
              </Reorder.Group>
            </motion.div>
          </AnimatePresence>
        </div>
      )}
    </aside>
  );
}
