'use client';

import { useEffect, useRef } from 'react';
import { useStageStore } from '@/lib/store';
import { analyticsService } from '@/lib/analytics/analytics';

const HEARTBEAT_INTERVAL = 30000; // 30 seconds

/**
 * Hook to automatically track analytics for a classroom session.
 * Tracks:
 * - Initial view (stage metadata)
 * - Slide changes (currentSceneId)
 * - Watch duration (heartbeat)
 */
export function useAnalytics(courseId: string | null) {
  const currentSceneId = useStageStore((s) => s.currentSceneId);
  const scenes = useStageStore((s) => s.scenes);
  const stage = useStageStore((s) => s.stage);
  
  const initialTrackedRef = useRef(false);
  const lastTrackedSceneIdRef = useRef<string | null>(null);

  // 1. Initial Course View tracking
  useEffect(() => {
    if (!courseId || !stage || initialTrackedRef.current) return;

    analyticsService.trackCourseView(
      courseId,
      stage.name || 'Untitled Course',
      scenes.length
    );
    initialTrackedRef.current = true;
  }, [courseId, stage, scenes.length]);

  // 2. Slide Change tracking
  useEffect(() => {
    if (!courseId || !currentSceneId || currentSceneId === lastTrackedSceneIdRef.current) return;

    const index = scenes.findIndex(s => s.id === currentSceneId);
    if (index !== -1) {
      analyticsService.trackSlideView(courseId, index);
      lastTrackedSceneIdRef.current = currentSceneId;
    }
  }, [courseId, currentSceneId, scenes]);

  // 3. Watch Duration heartbeat
  useEffect(() => {
    if (!courseId) return;

    const intervalId = setInterval(() => {
      analyticsService.trackWatchDuration(courseId, HEARTBEAT_INTERVAL / 1000);
    }, HEARTBEAT_INTERVAL);

    return () => clearInterval(intervalId);
  }, [courseId]);
}
