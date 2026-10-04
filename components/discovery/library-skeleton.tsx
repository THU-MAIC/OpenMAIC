'use client';

import { useI18n } from '@/lib/hooks/use-i18n';

import { ThumbnailSkeleton } from './thumbnail-skeleton';

/** Tiles in the skeleton: two rows of the widest grid. */
const SKELETON_FOLDERS = 2;
const SKELETON_COURSES = 6;

/** The pulse the course cards use while their thumbnail loads. */
const PULSE = 'animate-pulse bg-slate-200/70 dark:bg-slate-700/50';

/**
 * Placeholder for the home library while its course and folder lists load.
 *
 * It mirrors the loaded layout exactly: the same grid, and tiles built from
 * the ClassroomCard / FolderCard boxes (a 16:9 thumbnail and a title row whose
 * height comes from the same text styles), so the real cards replace it
 * without moving anything.
 */
export function LibrarySkeleton() {
  const { t } = useI18n();
  return (
    <div className="pt-8" role="status" aria-label={t('common.loading')} data-library-skeleton>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-8">
        {Array.from({ length: SKELETON_FOLDERS }, (_, i) => (
          <SkeletonTile key={`folder-${i}`} folder />
        ))}
        {Array.from({ length: SKELETON_COURSES }, (_, i) => (
          <SkeletonTile key={`course-${i}`} />
        ))}
      </div>
    </div>
  );
}

function SkeletonTile({ folder = false }: { folder?: boolean }) {
  return (
    <div aria-hidden data-skeleton-tile={folder ? 'folder' : 'course'}>
      <div className="relative w-full aspect-[16/9] rounded-2xl bg-slate-100 dark:bg-slate-800/80 overflow-hidden">
        {folder ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className={`size-14 rounded-2xl ${PULSE}`} />
          </div>
        ) : (
          <ThumbnailSkeleton />
        )}
      </div>
      <div className="mt-2.5 px-1 flex items-center gap-2">
        {/* Same type styles as the real badge and title, with transparent
            text, so the row is exactly as tall as a loaded card's. */}
        <span
          className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium text-transparent select-none ${PULSE}`}
        >
          00 · 00/00
        </span>
        <p className="font-medium text-[15px] min-w-0 flex-1 text-transparent select-none">
          <span className={`inline-block w-3/4 rounded-md ${PULSE}`}>&nbsp;</span>
        </p>
      </div>
    </div>
  );
}
