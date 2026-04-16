'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useCanvasStore } from '@/lib/store/canvas';
import type { PPTElement } from '@/lib/types/slides';
import {
  buildSlideTextRevealPlan,
  localSlideTextReveal,
  type SlideTextRevealRange,
} from '@/lib/playback/slide-text-reveal-plan';

interface PlaybackTextRevealContextValue {
  readonly getLocalProgress: (elementId: string) => number | null;
}

const PlaybackTextRevealContext = createContext<PlaybackTextRevealContextValue | null>(null);

export function PlaybackTextRevealProvider({
  elements,
  children,
}: {
  readonly elements: PPTElement[];
  readonly children: ReactNode;
}) {
  const globalProgress = useCanvasStore.use.slideTextRevealProgress();
  const slideTextRevealUnlockedIds = useCanvasStore((s) => s.slideTextRevealUnlockedIds);
  const { totalUnits, unitsById } = useMemo(() => buildSlideTextRevealPlan(elements), [elements]);

  const value = useMemo<PlaybackTextRevealContextValue>(
    () => ({
      getLocalProgress: (elementId: string) => {
        const range: SlideTextRevealRange | undefined = unitsById[elementId];
        if (slideTextRevealUnlockedIds[elementId] && range) {
          return 1;
        }
        return localSlideTextReveal(globalProgress, totalUnits, range);
      },
    }),
    [globalProgress, slideTextRevealUnlockedIds, totalUnits, unitsById],
  );

  return (
    <PlaybackTextRevealContext.Provider value={value}>{children}</PlaybackTextRevealContext.Provider>
  );
}

export function usePlaybackTextReveal(): PlaybackTextRevealContextValue | null {
  return useContext(PlaybackTextRevealContext);
}
