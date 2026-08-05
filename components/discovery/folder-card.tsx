'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Folder, Pencil, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import type { Slide } from '@openmaic/dsl';
import type { FolderRecord } from '@/lib/utils/database';

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
  onRequestDelete,
  onDropCourse,
}: {
  folder: FolderRecord;
  courseCount: number;
  /** Up to {@link MAX_COVERS} first-slide thumbnails of the member courses. */
  coverSlides: Slide[];
  onOpen: () => void;
  onRename: (newName: string) => Promise<string | null>;
  onRequestDelete: () => void;
  /** Files the dragged course (its stage id is in the payload) into this folder. */
  onDropCourse: (stageId: string) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [thumbWidth, setThumbWidth] = useState(0);

  const startEditing = () => {
    setDraft(folder.name);
    setError(null);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const commit = async () => {
    if (!editing || submitting) return;
    const trimmed = draft.trim();
    if (trimmed === folder.name) {
      setEditing(false);
      return;
    }
    setSubmitting(true);
    const err = await onRename(trimmed);
    setSubmitting(false);
    if (err) {
      setError(err);
      inputRef.current?.animate(
        [
          { transform: 'translateX(0)' },
          { transform: 'translateX(-4px)' },
          { transform: 'translateX(4px)' },
          { transform: 'translateX(0)' },
        ],
        { duration: 200 },
      );
      return;
    }
    setEditing(false);
  };

  const covers = coverSlides.slice(0, MAX_COVERS);
  const isEmpty = covers.length === 0;

  return (
    <div
      className="group cursor-pointer"
      onClick={editing ? undefined : onOpen}
      onDragOver={(e) => {
        if (editing) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropActive(true);
      }}
      onDragLeave={(e) => {
        // Only clear when leaving the card entirely, not when crossing children.
        if (e.currentTarget === e.target) setDropActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
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
        {isEmpty ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <div className="size-14 rounded-2xl bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center">
              <Folder className="size-7 text-violet-500 dark:text-violet-300" />
            </div>
          </div>
        ) : (
          <CoverStack covers={covers} thumbWidth={thumbWidth} setThumbWidth={setThumbWidth} />
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

        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <button
              type="button"
              aria-label={t('classroom.delete')}
              onClick={(e) => {
                e.stopPropagation();
                onRequestDelete();
              }}
              className="absolute top-2 right-2 size-7 inline-flex items-center justify-center rounded-full bg-black/30 hover:bg-destructive/80 text-white hover:text-white backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity z-10"
            >
              <Trash2 className="size-3.5" />
            </button>
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
 * Stack up to three course covers inside the folder tile. Each cover is offset
 * and scaled down slightly; the frontmost cover is the most recently updated
 * member. A small ResizeObserver feeds the thumbnail its rendered width so the
 * slide canvas can size correctly.
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

  // Measure the cover area so every SlideThumbnail sizes to it.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setThumbWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [setThumbWidth]);

  // Ordered back→front so the frontmost is the last (most recent).
  const ordered = [...covers].reverse();

  return (
    <div ref={containerRef} className="absolute inset-0">
      {ordered.map((cover, i) => {
        const depth = ordered.length - 1 - i; // 0 = frontmost
        const scale = 1 - depth * 0.06;
        const offsetY = depth * 6;
        const offsetX = depth * 4;
        return (
          <div
            key={i}
            className="absolute inset-0 flex items-center justify-center p-2"
            style={{
              transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
              zIndex: ordered.length - depth,
              opacity: 1 - depth * 0.12,
            }}
          >
            {thumbWidth > 0 && (
              <div className="w-[78%] aspect-[16/9] rounded-lg overflow-hidden shadow-md ring-1 ring-black/5">
                <SlideThumbnail
                  slide={cover}
                  size={Math.round(thumbWidth * 0.78)}
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
