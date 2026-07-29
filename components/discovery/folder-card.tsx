'use client';

import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Folder, Pencil, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { FolderRecord } from '@/lib/utils/database';

/**
 * Folder card. Same visual footprint as a ClassroomCard (16:9 tile + title
 * row). Hover shows rename / delete buttons matching the course-card ✏️/🗑️.
 *
 * Rename is inline on the card itself: clicking ✏️ swaps the title for an
 * input. `onRename` returns `null` on success (exits editing) or an error
 * string on failure (keeps editing, shakes the input).
 */
export function FolderCard({
  folder,
  courseCount,
  onOpen,
  onRename,
  onRequestDelete,
}: {
  folder: FolderRecord;
  courseCount: number;
  onOpen: () => void;
  onRename: (newName: string) => Promise<string | null>;
  onRequestDelete: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className="group cursor-pointer" onClick={editing ? undefined : onOpen}>
      <div className="relative w-full aspect-[16/9] rounded-2xl bg-gradient-to-br from-violet-50 to-blue-50 dark:from-violet-900/20 dark:to-blue-900/20 overflow-hidden transition-transform duration-200 group-hover:scale-[1.02] ring-1 ring-violet-200/50 dark:ring-violet-800/40">
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <div className="size-14 rounded-2xl bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center">
            <Folder className="size-7 text-violet-500 dark:text-violet-300" />
          </div>
          <span className="text-[12px] text-muted-foreground">
            {courseCount} {t('classroom.folderCourseCountUnit')}
          </span>
        </div>

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
              className="absolute top-2 right-2 size-7 inline-flex items-center justify-center rounded-full bg-black/30 hover:bg-destructive/80 text-white hover:text-white backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity"
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
              className="absolute top-2 right-11 size-7 inline-flex items-center justify-center rounded-full bg-black/30 hover:bg-black/50 text-white hover:text-white backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity"
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
