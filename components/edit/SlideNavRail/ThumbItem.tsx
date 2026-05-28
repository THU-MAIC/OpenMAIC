'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Reorder } from 'motion/react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SceneThumbnailContent } from '@/components/stage/scene-thumbnail-content';
import { SCENE_CREATION_ENABLED } from '@/lib/edit/scene-creation-enabled';
import type { Scene } from '@/lib/types/stage';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';

interface ThumbItemProps {
  readonly scene: Scene;
  readonly index: number;
  readonly active: boolean;
  readonly canDelete: boolean;
  readonly onActivate: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
}

function ThumbItemComponent({
  scene,
  index,
  active,
  canDelete,
  onActivate,
  onDuplicate,
  onDelete,
}: ThumbItemProps) {
  const { t } = useI18n();
  const viewportSize = useCanvasStore.use.viewportSize();
  const viewportRatio = useCanvasStore.use.viewportRatio();
  const updateScene = useStageStore.use.updateScene();
  const ref = useRef<HTMLLIElement>(null);
  const visible = useNearViewport(ref);

  // Inline title-edit state. `draft` is only used while renaming; when
  // idle we derive the visible title from `scene.title` directly so an
  // external rename (other tab / Duplicate suffix) shows up without a
  // sync effect. `startRename` seeds `draft` once at session start.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(scene.title);
  const inputRef = useRef<HTMLInputElement>(null);

  const startRename = useCallback(() => {
    setDraft(scene.title);
    setRenaming(true);
    // Focus + select on next tick so the input is mounted.
    queueMicrotask(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
  }, [scene.title]);

  const commitRename = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== scene.title) {
      updateScene(scene.id, { title: trimmed });
    }
    setRenaming(false);
  }, [draft, scene.id, scene.title, updateScene]);

  const cancelRename = useCallback(() => {
    // Reset draft to the canonical title so the next rename session
    // starts from a clean state.
    setDraft(scene.title);
    setRenaming(false);
  }, [scene.title]);

  return (
    <Reorder.Item
      ref={ref}
      value={scene.id}
      // `layout="position"` restricts the implicit layout animation to
      // y-axis position changes (what reorder needs). Width changes from
      // rail-resize don't fire layout animations because vertical
      // stacking keeps left/top stable; only height/width would change,
      // and those are NOT covered by `position`. `layout={false}` was
      // tried earlier but broke drag-to-reorder entirely — Reorder.Item
      // needs the layout tracker to compute the drag transform's origin.
      layout="position"
      whileDrag={{
        scale: 1.03,
        rotate: -0.4,
        zIndex: 40,
        transition: { duration: 0.15, ease: [0.22, 1, 0.36, 1] },
      }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      <div
        role="button"
        tabIndex={0}
        data-active={active}
        onClick={renaming ? undefined : onActivate}
        onKeyDown={(e) => {
          if (renaming) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onActivate();
          }
        }}
        // Matches playback `SceneSidebar` tile family — index badge +
        // title header row above an aspect-video thumbnail card, whole
        // tile flipped to violet-50 + ring when active. Differences from
        // playback: inline title edit via the more-actions menu, and a
        // hover-revealed three-dot menu (the only editor affordance
        // overlaid on the playback shape).
        className={cn(
          'group/thumb relative flex cursor-pointer select-none flex-col gap-1 rounded-lg p-1.5',
          'outline-none transition-colors duration-150',
          active
            ? 'bg-violet-50 ring-1 ring-violet-200 dark:bg-violet-900/20 dark:ring-violet-700'
            : 'hover:bg-zinc-50/80 dark:hover:bg-zinc-800/50',
        )}
      >
        {/* Scene header — index badge + title. Title doubles as the
            inline rename surface when `renaming` is true. */}
        <div className="flex items-center justify-between gap-1 px-2 pt-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-black leading-none tabular-nums',
                active
                  ? 'bg-violet-600 text-white shadow-sm shadow-violet-500/30 dark:bg-violet-500'
                  : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400',
              )}
            >
              {index + 1}
            </span>
            {renaming ? (
              <input
                ref={inputRef}
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label={t('edit.nav.rename')}
                className={cn(
                  'min-w-0 flex-1 truncate rounded-sm bg-white px-1 py-0 text-xs font-bold outline-none',
                  'ring-1 ring-violet-400 focus:ring-violet-500',
                  'text-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-violet-500',
                )}
              />
            ) : (
              <span
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRename();
                }}
                className={cn(
                  'truncate text-xs font-bold transition-colors',
                  active
                    ? 'text-violet-700 dark:text-violet-300'
                    : 'text-zinc-600 group-hover/thumb:text-zinc-900 dark:text-zinc-300 dark:group-hover/thumb:text-zinc-100',
                )}
                title={scene.title}
              >
                {scene.title || `${t('edit.sceneType.' + scene.type)} ${index + 1}`}
              </span>
            )}
          </div>

          {/* Three-dot overflow menu — hover-revealed, always visible
              while open. Hidden during inline rename so the input has
              the full header row. */}
          {!renaming && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  aria-label={t('edit.nav.moreActions')}
                  data-testid="slide-nav-more"
                  className={cn(
                    'shrink-0 rounded p-0.5 text-zinc-400 transition-opacity',
                    'opacity-0 group-hover/thumb:opacity-100 data-[state=open]:opacity-100',
                    'hover:bg-zinc-200/80 hover:text-zinc-700',
                    'dark:hover:bg-zinc-700 dark:hover:text-zinc-200',
                  )}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="right"
                className="min-w-36"
                onClick={(e) => e.stopPropagation()}
              >
                <DropdownMenuItem onSelect={startRename}>{t('edit.nav.rename')}</DropdownMenuItem>
                {SCENE_CREATION_ENABLED && (
                  <DropdownMenuItem onSelect={onDuplicate}>
                    {t('edit.nav.duplicate')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem disabled={!canDelete} onSelect={onDelete} variant="destructive">
                  {t('edit.nav.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Thumbnail card — same shape as playback SceneSidebar's tile. */}
        <div
          className={cn(
            'relative aspect-video w-full overflow-hidden rounded',
            'bg-zinc-100 ring-1 ring-black/5 dark:bg-zinc-800 dark:ring-white/5',
          )}
        >
          <div className="absolute inset-0 flex items-center justify-center">
            <SceneThumbnailContent
              scene={scene}
              viewportSize={viewportSize}
              viewportRatio={viewportRatio}
              visible={visible}
            />
          </div>
        </div>
      </div>
    </Reorder.Item>
  );
}

/**
 * One tile in the Pro mode rail. Visual structure deliberately mirrors
 * playback `SceneSidebar` — index badge + title row above an aspect-
 * video thumbnail card, whole tile rounded with a violet background +
 * ring when active — so the two sidebars read as the same component
 * family across mode toggle. Editor-only additions: hover-revealed
 * three-dot menu (Rename / Duplicate / Delete) and inline title rename
 * (also reachable via double-click on the title text).
 *
 * All scene types are first-class — slides render a live
 * `ThumbnailSlide`, non-slide scenes render the same stylised mockups
 * playback's `SceneSidebar` uses. EditShell renders non-slide scenes
 * read-only inside Pro mode (no auto-exit on click).
 */
export const ThumbItem = memo(ThumbItemComponent);

/**
 * Cheap "near viewport" IntersectionObserver so off-screen thumbs
 * skip the live ThumbnailSlide render (which mounts a downscaled
 * slide-renderer scene). Items within 200px of the viewport remain
 * eager so scrolling feels instant.
 */
function useNearViewport(ref: React.RefObject<Element | null>) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setVisible(e.isIntersecting);
      },
      { root: null, rootMargin: '200px 0px', threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return visible;
}
