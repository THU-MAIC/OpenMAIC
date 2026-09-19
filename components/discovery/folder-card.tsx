'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Folder, Pencil, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import type { Slide } from '@openmaic/dsl';
import type { FolderRecord } from '@/lib/utils/database';
import type { DeleteFolderMode } from '@/lib/utils/stage-storage';

/** Maximum number of course covers stacked on a folder tile. */
const MAX_COVERS = 3;

/**
 * Folder card. Same visual footprint as a ClassroomCard (16:9 tile + title
 * row). The tile shows up to {@link MAX_COVERS} member course covers stacked
 * with a slight offset; an empty folder falls back to a centered folder icon.
 *
 * Hover shows rename / delete buttons matching the course-card ✏️/🗑️. The tile
 * is also a drop target: dragging a course card onto it files the course into
 * this folder (the hover 📂 menu remains as the accessible fallback).
 */
export function FolderCard({
  folder,
  courseCount,
  coverSlides,
  onOpen,
  onRename,
  onDelete,
  onDropCourse,
}: {
  folder: FolderRecord;
  courseCount: number;
  /** Up to {@link MAX_COVERS} first-slide thumbnails of the member courses. */
  coverSlides: Slide[];
  onOpen: () => void;
  onRename: (newName: string) => Promise<string | null>;
  /** Delete the folder with the chosen mode. */
  onDelete: (mode: DeleteFolderMode) => void;
  /** Files the dragged course (its stage id is in the payload) into this folder. */
  onDropCourse: (stageId: string) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [thumbWidth, setThumbWidth] = useState(0);

  // Clear lingering drop highlight when a course drag ends (covers Escape-
  // cancelled drags that may not fire dragleave on every target).
  useEffect(() => {
    const handler = () => {
      dragDepth.current = 0;
      setDropActive(false);
    };
    window.addEventListener('course-drag-end', handler);
    return () => window.removeEventListener('course-drag-end', handler);
  }, []);

  const startEditing = () => {
    setDraft(folder.name);
    setError(null);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const shake = () => {
    inputRef.current?.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-4px)' },
        { transform: 'translateX(4px)' },
        { transform: 'translateX(0)' },
      ],
      { duration: 200 },
    );
  };

  const commit = async () => {
    if (!editing || submitting) return;
    const trimmed = draft.trim();
    if (trimmed === folder.name) {
      setEditing(false);
      return;
    }
    // Empty name: show an error and keep editing (do not silently exit).
    if (!trimmed) {
      setError(t('classroom.folderNameEmpty'));
      shake();
      return;
    }
    setSubmitting(true);
    const err = await onRename(trimmed);
    setSubmitting(false);
    if (err) {
      setError(err);
      shake();
      return;
    }
    setEditing(false);
  };

  const covers = coverSlides.slice(0, MAX_COVERS);
  // Emptiness is derived from courseCount (the authoritative source), not from
  // covers.length — a non-empty folder whose courses have no cached thumbnails
  // must not show the empty-folder icon. `hasCovers` gates the cover stack.
  const hasCovers = covers.length > 0;

  return (
    <div
      className="group cursor-pointer"
      onClick={editing ? undefined : onOpen}
      onDragEnter={(e) => {
        if (editing) return;
        // Only react to course-card drags (carrying a stage-id payload).
        if (!Array.from(e.dataTransfer.types).includes('text/stage-id')) return;
        dragDepth.current += 1;
        setDropActive(true);
      }}
      onDragOver={(e) => {
        if (editing) return;
        if (!Array.from(e.dataTransfer.types).includes('text/stage-id')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDragLeave={() => {
        // dragenter/dragleave fire per child element; balance them with a
        // counter so the highlight clears only when the pointer fully exits.
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDropActive(false);
        const stageId = e.dataTransfer.getData('text/stage-id');
        if (stageId) onDropCourse(stageId);
      }}
    >
      <div
        ref={thumbRef}
        className={cn(
          'relative w-full aspect-[16/9] rounded-2xl bg-gradient-to-br from-violet-50 to-blue-50 dark:from-violet-900/20 dark:to-blue-900/20 overflow-hidden transition-transform duration-200 group-hover:scale-[1.02] ring-1',
          dropActive
            ? 'ring-2 ring-violet-500 ring-offset-2 ring-offset-background scale-[1.03]'
            : 'ring-violet-200/50 dark:ring-violet-800/40',
        )}
      >
        {hasCovers ? (
          <CoverStack covers={covers} thumbWidth={thumbWidth} setThumbWidth={setThumbWidth} />
        ) : courseCount === 0 ? (
          // Truly empty folder: folder icon.
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <div className="size-14 rounded-2xl bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center">
              <Folder className="size-7 text-violet-500 dark:text-violet-300" />
            </div>
          </div>
        ) : (
          // Non-empty but no cached covers: a neutral stacked-card placeholder
          // distinct from the empty-folder icon, so it does not read as empty.
          <div className="absolute inset-0 flex items-center justify-center">
            <div
              className="w-[60%] aspect-[16/9] rounded-xl bg-violet-200/60 dark:bg-violet-800/30 shadow-md ring-1 ring-violet-300/30 dark:ring-violet-700/30"
              style={{ transform: 'translate(-3%, 2%)' }}
            />
            <div
              className="absolute w-[60%] aspect-[16/9] rounded-xl bg-violet-300/50 dark:bg-violet-700/20 shadow-md ring-1 ring-violet-300/30 dark:ring-violet-700/30"
              style={{ transform: 'translate(3%, -1%)' }}
            />
          </div>
        )}

        {/* Course count badge — always visible (bottom-right). */}
        <span className="absolute bottom-2 right-2 z-10 inline-flex items-center rounded-full bg-black/40 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
          {courseCount} {t('classroom.folderCourseCountUnit')}
        </span>

        {dropActive && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-violet-500/20 backdrop-blur-[2px]">
            <Folder className="size-8 text-white drop-shadow" />
          </div>
        )}

        {/* Hover actions — hidden while a delete confirmation is shown. */}
        {!confirmingDelete && (
          <AnimatePresence>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {/* Delete — empty folder: inline confirm; non-empty: dropdown menu. */}
              {courseCount === 0 ? (
                <button
                  type="button"
                  aria-label={t('classroom.delete')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingDelete(true);
                  }}
                  className="absolute top-2 right-2 size-7 inline-flex items-center justify-center rounded-full bg-black/30 hover:bg-destructive/80 text-white hover:text-white backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity z-10"
                >
                  <Trash2 className="size-3.5" />
                </button>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('classroom.delete')}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="absolute top-2 right-2 size-7 inline-flex items-center justify-center rounded-full bg-black/30 hover:bg-destructive/80 text-white hover:text-white backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity z-10"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    onClick={(e) => e.stopPropagation()}
                    className="min-w-[200px]"
                  >
                    <DropdownMenuItem
                      onClick={() => onDelete('ungroup')}
                      className="gap-2 text-[13px]"
                    >
                      <Folder className="size-3.5 shrink-0 mt-0.5" />
                      <span className="flex flex-col">
                        <span>{t('classroom.deleteFolderOnly')}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {t('classroom.deleteFolderUngroupDesc')}
                        </span>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => setConfirmingDelete(true)}
                      className="gap-2 text-[13px] text-destructive focus:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                      {t('classroom.deleteFolderAndCourses', { count: courseCount })}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <button
                type="button"
                aria-label={t('classroom.rename')}
                onClick={(e) => {
                  e.stopPropagation();
                  startEditing();
                }}
                className="absolute top-2 right-11 size-7 inline-flex items-center justify-center rounded-full bg-black/30 hover:bg-black/50 text-white hover:text-white backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity z-10"
              >
                <Pencil className="size-3.5" />
              </button>
            </motion.div>
          </AnimatePresence>
        )}

        {/* Inline delete confirmation overlay (empty folder + destructive path). */}
        <AnimatePresence>
          {confirmingDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/50 backdrop-blur-[6px]"
              onClick={(e) => e.stopPropagation()}
            >
              {courseCount > 0 && (
                <div className="flex items-center gap-1.5 text-amber-300">
                  <AlertTriangle className="size-3.5" />
                  <span className="text-[11px] font-medium">
                    {t('classroom.deleteFolderConfirmRemove')}
                  </span>
                </div>
              )}
              <span className="px-4 text-center text-[13px] font-medium text-white/90">
                {courseCount === 0
                  ? t('classroom.deleteFolderEmptyDesc')
                  : t('classroom.deleteFolderTitle', { name: folder.name })}
              </span>
              <div className="flex gap-2">
                <button
                  className="px-3.5 py-1 rounded-lg text-[12px] font-medium bg-white/15 text-white/80 hover:bg-white/25 backdrop-blur-sm transition-colors"
                  onClick={() => setConfirmingDelete(false)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="px-3.5 py-1 rounded-lg text-[12px] font-medium bg-red-500/90 text-white hover:bg-red-500 transition-colors"
                  onClick={() => {
                    // Close the overlay before the async delete: on success the
                    // card unmounts; on failure the user sees the error toast
                    // and the card is interactive again (not stuck behind the
                    // backdrop).
                    setConfirmingDelete(false);
                    onDelete(courseCount === 0 ? 'ungroup' : 'remove');
                  }}
                >
                  {t('classroom.delete')}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="mt-2.5 px-1 flex items-center gap-2">
        <span className="shrink-0 inline-flex items-center rounded-full bg-violet-100 dark:bg-violet-900/30 px-2 py-0.5 text-[11px] font-medium text-violet-600 dark:text-violet-400">
          {t('classroom.folderBadge')}
        </span>
        {editing ? (
          <div className="flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setEditing(false);
              }}
              onBlur={commit}
              disabled={submitting}
              maxLength={80}
              className="w-full bg-transparent border-b border-violet-400/60 text-[15px] font-medium text-foreground/90 outline-none disabled:opacity-50"
            />
            {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
          </div>
        ) : (
          <p className="font-medium text-[15px] truncate text-foreground/90 min-w-0">
            {folder.name}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Render member course covers as a tidy, slightly-fanned stack: each rear cover
 * peeks out from behind the one in front, offset up and to alternating sides,
 * with a gentle rotation. Inspired by the iOS Photos / macOS folder cover —
 * restrained, geometric, readable. The frontmost cover is the most recently
 * updated member.
 */
function CoverStack({
  covers,
  thumbWidth,
  setThumbWidth,
}: {
  covers: Slide[];
  thumbWidth: number;
  setThumbWidth: (w: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setThumbWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [setThumbWidth]);

  const count = covers.length;
  // `covers` is ordered most-recent-first; that cover is the front (drawn last,
  // on top). Rear covers offset up + alternate sides + small rotation so a sliver
  // of each is visible behind the front. Offsets are % of the tile for consistency.
  const rear: Array<{ dx: number; dy: number; rot: number }> = [
    { dx: -8, dy: 10, rot: -5 }, // rearmost (left, up, tilted left)
    { dx: 8, dy: 5, rot: 5 }, // mid (right, up a bit, tilted right)
  ];

  return (
    <div ref={containerRef} className="absolute inset-0 flex items-center justify-center">
      {/* Render back→front: iterate covers in reverse so the front is last (on top). */}
      {[...covers].reverse().map((cover, i) => {
        const depthFromFront = count - 1 - i; // 0 = frontmost
        const isFront = depthFromFront === 0;
        const cfg = rear[depthFromFront - 1] ?? rear[rear.length - 1];
        const widthPct = isFront ? 66 : 60;
        return (
          <div
            key={i}
            className="absolute"
            style={{
              width: `${widthPct}%`,
              transform: isFront
                ? 'translate(0, 0)'
                : `translate(${cfg.dx}%, -${cfg.dy}%) rotate(${cfg.rot}deg)`,
              zIndex: i + 1,
              opacity: isFront ? 1 : 0.85,
            }}
          >
            {thumbWidth > 0 && (
              <div className="aspect-[16/9] w-full rounded-xl overflow-hidden shadow-md ring-1 ring-black/5 bg-slate-200 dark:bg-slate-700">
                <SlideThumbnail
                  slide={cover}
                  size={Math.round((thumbWidth * widthPct) / 100)}
                  viewportSize={cover.viewportSize ?? 1000}
                  viewportRatio={cover.viewportRatio ?? 0.5625}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
