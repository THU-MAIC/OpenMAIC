'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Slide } from '@openmaic/dsl';
import {
  ensureWorkspaceMetadata,
  listWorkspaceCourses,
  type WorkspaceCourse,
} from '@/lib/workspace';
import { getFirstSlideByStages, revokeThumbnailSlideMediaUrls } from '@/lib/utils/stage-storage';
import { warmOpenMaicOfflinePages } from '@/lib/offline/service-worker';

const RECENT_COURSE_SHELL_LIMIT = 9;

export function useWorkspaceCourses() {
  const [courses, setCourses] = useState<WorkspaceCourse[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, Slide>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await ensureWorkspaceMetadata();
      const nextCourses = await listWorkspaceCourses();
      const nextThumbnails = await getFirstSlideByStages(nextCourses.map(({ stage }) => stage.id));
      warmOpenMaicOfflinePages(
        nextCourses
          .slice(0, RECENT_COURSE_SHELL_LIMIT)
          .flatMap(({ stage }) => [`/courses/${stage.id}`, `/classroom/${stage.id}`]),
      );
      setCourses(nextCourses);
      setThumbnails((current) => {
        revokeThumbnailSlideMediaUrls(current);
        return nextThumbnails;
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '无法读取本机课程');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const handleChange = () => void refresh();
    window.addEventListener('openmaic:workspace-changed', handleChange);
    return () => window.removeEventListener('openmaic:workspace-changed', handleChange);
  }, [refresh]);

  useEffect(
    () => () => {
      revokeThumbnailSlideMediaUrls(thumbnails);
    },
    [thumbnails],
  );

  return { courses, thumbnails, loading, error, refresh };
}
