'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, Reorder, motion, useReducedMotion } from 'motion/react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useDeletedSceneRecycle } from '@/lib/edit/deleted-scene-recycle';
import { createBlankSlideScene, duplicateSlideScene } from '@/lib/edit/slide-defaults';
import { SCENE_CREATION_ENABLED } from '@/lib/edit/scene-creation-enabled';
import { CHROME_DURATION_MS, CHROME_EASE, CHROME_EASE_CSS } from '@/lib/edit/transitions';
import type { Scene } from '@/lib/types/stage';
import { ThumbItem } from './ThumbItem';
import { InsertionZone } from './InsertionZone';

const RAIL_COLLAPSED_PX = 56;
const RAIL_MIN_PX = 180;
const RAIL_MAX_PX = 360;

/**
 * Pro mode slide-navigation left rail (Studio Editor aesthetic).
 *
 * Layout: a vertical thumbnail strip with monospaced index captions
 * below each tile, inter-thumb "+" insertion zones revealed on hover,
 * and a collapse toggle at the rail head. All scene types are
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

  const currentScene = useMemo(
    () => scenes.find((s) => s.id === currentSceneId) ?? null,
    [scenes, currentSceneId],
  );

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
      // Switching to a non-slide scene is fine — useEditModeLock will
      // auto-exit Pro mode the moment the new scene is uneditable.
      setCurrentSceneId(sceneId);
    },
    [currentSceneId, setCurrentSceneId],
  );

  /**
   * Insert a fresh blank slide *before* the given scene. The first
   * InsertionZone (above the first thumb) calls this with `scenes[0]`
   * so it ends up at index 0 — `setScenes([blank, ...scenes])` is
   * used directly there since the `insertSceneAfter` API only supports
   * insertion after an existing anchor.
   */
  const handleInsertBefore = useCallback(
    (beforeSceneId: string) => {
      if (!stage) return;
      const beforeIndex = scenes.findIndex((s) => s.id === beforeSceneId);
      if (beforeIndex < 0) return;
      const blank = createBlankSlideScene(stage.id, t('edit.nav.untitledSlide'), beforeIndex + 1);
      if (beforeIndex === 0) {
        // Prepend: setScenes rebalances `order` to match the array index.
        setScenes([blank, ...scenes]);
        setCurrentSceneId(blank.id);
        return;
      }
      const anchor = scenes[beforeIndex - 1];
      insertSceneAfter(anchor.id, blank);
      setCurrentSceneId(blank.id);
    },
    [insertSceneAfter, scenes, setCurrentSceneId, setScenes, stage, t],
  );

  const handleInsertAt = useCallback(
    (afterSceneId: string | null) => {
      if (!stage) return;
      const anchor = afterSceneId
        ? scenes.find((s) => s.id === afterSceneId)
        : (currentScene ?? scenes[scenes.length - 1]);
      if (!anchor) return;
      const anchorIndex = scenes.findIndex((s) => s.id === anchor.id);
      const newOrder = anchorIndex + 2;
      const blank = createBlankSlideScene(stage.id, t('edit.nav.untitledSlide'), newOrder);
      insertSceneAfter(anchor.id, blank);
      setCurrentSceneId(blank.id);
    },
    [currentScene, insertSceneAfter, scenes, setCurrentSceneId, stage, t],
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
        width: collapsed ? RAIL_COLLAPSED_PX : persistedWidth,
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
      {/* Header band — mirrors playback `SceneSidebar`: OpenMAIC logo
          on the left (click → home), action cluster on the right.
          Height (h-10 + mt-3 mb-1 = ~56px) matches playback so the
          chrome top edge stays at the same screen pixel across the
          mode swap. */}
      <div
        className={cn(
          'shrink-0 px-3 mt-3 mb-1 h-10',
          collapsed ? 'flex flex-col items-center gap-1' : 'flex items-center justify-between',
        )}
      >
        {!collapsed && (
          <button
            type="button"
            onClick={() => router.push('/')}
            title={t('generation.backToHome')}
            className="flex items-center gap-2 cursor-pointer rounded-lg px-1.5 -mx-1.5 py-1 -my-1 hover:bg-gray-100/80 dark:hover:bg-gray-800/60 active:scale-[0.97] transition-all duration-150"
          >
            <img src="/logo-horizontal.png" alt="OpenMAIC" className="h-6" />
          </button>
        )}
        <div className={cn('flex items-center gap-1', collapsed && 'flex-col')}>
          {/* Insertion lives in the `InsertionZone` strips between (and
              before/after) thumbs now — no header `+` button. */}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? t('edit.nav.expand') : t('edit.nav.collapse')}
            title={collapsed ? t('edit.nav.expand') : t('edit.nav.collapse')}
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded-lg',
              'bg-gray-100/80 text-gray-500 ring-1 ring-black/[0.04]',
              'dark:bg-gray-800/80 dark:text-gray-400 dark:ring-white/[0.06]',
              'hover:bg-gray-200/90 hover:text-gray-700',
              'dark:hover:bg-gray-700/90 dark:hover:text-gray-200',
              'active:scale-90 transition-all duration-200',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Body — list padding (p-2 space-y-2) matches playback's scene
          list so spacing/density read the same. */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide pt-1">
        {collapsed ? (
          <CollapsedList
            scenes={scenes}
            currentSceneId={currentSceneId}
            onActivate={handleActivate}
          />
        ) : (
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
                    label={t('edit.nav.addSlide')}
                    onInsert={() => handleInsertBefore(scenes[0].id)}
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
                        label={t('edit.nav.addSlide')}
                        onInsert={() => handleInsertAt(scene.id)}
                      />
                    )}
                  </Fragment>
                ))}
              </Reorder.Group>
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </aside>
  );
}

interface CollapsedListProps {
  readonly scenes: readonly Scene[];
  readonly currentSceneId: string | null;
  readonly onActivate: (sceneId: string) => void;
}

function CollapsedList({ scenes, currentSceneId, onActivate }: CollapsedListProps) {
  return (
    <ol className="m-0 flex flex-col items-stretch gap-0.5 py-2 px-1.5 list-none">
      {scenes.map((scene, index) => {
        const active = scene.id === currentSceneId;
        const isSlide = scene.type === 'slide';
        return (
          <li key={scene.id}>
            <button
              type="button"
              onClick={() => onActivate(scene.id)}
              title={scene.title || `${index + 1}`}
              data-active={active}
              data-scene-type={scene.type}
              className={cn(
                'group/cl flex h-7 w-full items-center justify-center rounded-md',
                'font-mono text-[10px] leading-none tabular-nums tracking-wide transition-colors',
                active
                  ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/40'
                  : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-800 dark:hover:text-zinc-200',
                !isSlide && !active && 'text-zinc-400/80 dark:text-zinc-500/80',
              )}
            >
              {String(index + 1).padStart(2, '0')}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
