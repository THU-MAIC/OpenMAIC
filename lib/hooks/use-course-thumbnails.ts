import { useCallback, useEffect, useRef, useState } from 'react';
import type { Slide } from '@openmaic/dsl';
import { createLogger } from '@/lib/logger';
import { CourseThumbnailLoader } from '@/lib/utils/course-thumbnail-loader';
import { getFirstSlideForStage, revokeThumbnailSlideMediaUrls } from '@/lib/utils/stage-storage';

const log = createLogger('CourseThumbnails');

/** Thumbnail loads in flight at once (each is a document read plus its media). */
export const COURSE_THUMBNAIL_CONCURRENCY = 4;

export interface CourseThumbnails {
  /**
   * Loaded thumbnails by stage id: the first slide, or null for a course
   * without one. A course that is absent has not loaded (yet).
   */
  readonly thumbnails: Record<string, Slide | null>;
  /** Ask for a course's thumbnail at `version` (its updatedAt); returns a withdraw. */
  readonly requestThumbnail: (stageId: string, version: number) => () => void;
  /** Forget the thumbnails of courses no longer in the library. */
  readonly retainThumbnails: (stageIds: ReadonlySet<string>) => void;
}

/**
 * The home library's lazily loaded course thumbnails (see
 * {@link CourseThumbnailLoader}). Cards request their own thumbnail while near
 * the viewport; unmounting the page aborts what is still loading and releases
 * every thumbnail's object URLs.
 */
export function useCourseThumbnails(): CourseThumbnails {
  const [thumbnails, setThumbnails] = useState<Record<string, Slide | null>>({});
  const loaderRef = useRef<CourseThumbnailLoader | null>(null);

  const loader = useCallback((): CourseThumbnailLoader => {
    if (loaderRef.current) return loaderRef.current;
    const created: CourseThumbnailLoader = new CourseThumbnailLoader({
      load: getFirstSlideForStage,
      // Deferred so the card re-renders with its replacement before the old
      // object URLs are revoked.
      release: (slide) => window.setTimeout(() => revokeThumbnailSlideMediaUrls(slide), 0),
      concurrency: COURSE_THUMBNAIL_CONCURRENCY,
      onChange: () => {
        if (loaderRef.current === created) setThumbnails(created.snapshot());
      },
      onError: (stageId, error) => log.warn(`Failed to load thumbnail for ${stageId}:`, error),
    });
    loaderRef.current = created;
    return created;
  }, []);

  useEffect(
    () => () => {
      loaderRef.current?.dispose();
      loaderRef.current = null;
      setThumbnails({});
    },
    [],
  );

  const requestThumbnail = useCallback(
    (stageId: string, version: number) => loader().request(stageId, version),
    [loader],
  );
  const retainThumbnails = useCallback(
    (stageIds: ReadonlySet<string>) => loaderRef.current?.retain(stageIds),
    [],
  );

  return { thumbnails, requestThumbnail, retainThumbnails };
}
