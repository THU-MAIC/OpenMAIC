'use client';

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
import type { FolderRecord } from '@/lib/utils/database';

/**
 * Move-course-to-folder menu. Rendered as the 📂 button on a course tile
 * (the caller positions it via the ClassroomCard overlay). Lists "Ungrouped"
 * plus every folder (the current one gets a ✓), and a "New folder" entry that
 * asks the caller to open a folder dialog (a Radix DropdownMenu is modal, so an
 * inline <input> cannot keep focus there — the dialog is the focus surface).
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
  /** Request to create a new folder and move this course into it. */
  onCreateAndMove: () => void;
}) {
  const { t } = useI18n();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('classroom.moveToFolder')}
          title={t('classroom.moveToFolder')}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute top-2 right-20 size-7 inline-flex items-center justify-center rounded-full bg-black/30 hover:bg-black/50 text-white hover:text-white backdrop-blur-sm opacity-0 transition-opacity z-10 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 pointer-coarse:opacity-100 group-hover:opacity-100"
        >
          <FolderInput className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
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

        {/* New folder — opens the folder dialog (focus-safe). */}
        <DropdownMenuItem onClick={onCreateAndMove}>
          <Plus className="size-3.5 mr-1.5" />
          {t('classroom.newFolderInline')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
