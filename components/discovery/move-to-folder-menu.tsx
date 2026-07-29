'use client';

import { useState } from 'react';
import { Check, FolderInput, Plus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/hooks/use-i18n';
import { validateFolderName } from '@/lib/utils/folder-name-validation';
import type { FolderRecord } from '@/lib/utils/database';

/**
 * Move-course-to-folder menu. Rendered as the 📂 button on a course tile
 * (the caller positions it via the ClassroomCard overlay). Lists "Ungrouped"
 * plus every folder (the current one gets a ✓), and offers an inline "New
 * folder" entry that creates a folder and moves the course into it in one step.
 */
export function MoveToFolderMenu({
  folders,
  currentFolderId,
  onMove,
  onCreateAndMove,
}: {
  folders: FolderRecord[];
  currentFolderId: string | undefined;
  onMove: (folderId: string | undefined) => void;
  onCreateAndMove: (name: string) => void;
}) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const resetCreating = () => {
    setCreating(false);
    setDraft('');
    setError(null);
  };

  const submitNew = () => {
    const v = validateFolderName(draft);
    if (!v.ok) {
      setError(t('classroom.folderWidth', { width: v.width, max: 40 }));
      return;
    }
    const trimmed = draft.trim();
    if (folders.some((f) => f.name === trimmed)) {
      setError(t('classroom.folderNameExists'));
      return;
    }
    onCreateAndMove(trimmed);
    resetCreating();
  };

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) resetCreating();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('classroom.moveToFolder')}
          title={t('classroom.moveToFolder')}
          onClick={(e) => e.stopPropagation()}
          className="absolute top-2 right-20 size-7 inline-flex items-center justify-center rounded-full bg-black/30 hover:bg-black/50 text-white hover:text-white backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity z-10"
        >
          <FolderInput className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{t('classroom.moveToFolderLabel')}</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* Ungrouped */}
        <DropdownMenuItem
          onClick={() => onMove(undefined)}
          className="flex items-center justify-between"
        >
          <span>{t('classroom.ungrouped')}</span>
          {currentFolderId === undefined && <Check className="size-3.5 text-violet-500" />}
        </DropdownMenuItem>

        {/* All folders */}
        {folders.map((f) => (
          <DropdownMenuItem
            key={f.id}
            onClick={() => onMove(f.id)}
            className="flex items-center justify-between"
          >
            <span className="truncate">{f.name}</span>
            {currentFolderId === f.id && <Check className="size-3.5 text-violet-500 shrink-0" />}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        {/* Inline new-folder (create + move in one step) */}
        {creating ? (
          <div className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNew();
                if (e.key === 'Escape') resetCreating();
              }}
              placeholder={t('classroom.folderNamePlaceholder')}
              className="w-full rounded border border-border bg-background px-2 py-1 text-[13px] outline-none focus:ring-1 focus:ring-violet-400"
            />
            {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
          </div>
        ) : (
          <DropdownMenuItem onClick={() => setCreating(true)}>
            <Plus className="size-3.5 mr-1.5" />
            {t('classroom.newFolderInline')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
