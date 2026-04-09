'use client';

import { useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SceneNavigationOverlayProps {
  readonly currentSceneIndex: number;
  readonly scenesCount: number;
  readonly onPrevSlide: () => void;
  readonly onNextSlide: () => void;
  readonly isPresenting?: boolean;
}

export function SceneNavigationOverlay({
  currentSceneIndex,
  scenesCount,
  onPrevSlide,
  onNextSlide,
  isPresenting,
}: SceneNavigationOverlayProps) {
  const canGoPrev = currentSceneIndex > 0;
  const canGoNext = currentSceneIndex < scenesCount - 1;

  // Keyboard navigation: left/right arrow keys
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't intercept when user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft' && canGoPrev) {
        e.preventDefault();
        onPrevSlide();
      } else if (e.key === 'ArrowRight' && canGoNext) {
        e.preventDefault();
        onNextSlide();
      }
    },
    [canGoPrev, canGoNext, onPrevSlide, onNextSlide],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (scenesCount <= 1) return null;

  const btnBase = cn(
    'absolute top-1/2 -translate-y-1/2 z-[108]',
    'w-12 h-12 sm:w-14 sm:h-14 rounded-full',
    'flex items-center justify-center',
    'bg-white/70 dark:bg-gray-800/70 backdrop-blur-md',
    'shadow-lg shadow-black/5 dark:shadow-black/20',
    'border border-gray-200/50 dark:border-gray-700/50',
    'transition-all duration-200 cursor-pointer',
    'hover:bg-white/90 dark:hover:bg-gray-800/90 hover:scale-105 active:scale-95',
    // Visible on mobile, fade-in on hover for desktop
    'opacity-60 sm:opacity-0 group-hover/canvas:opacity-80 hover:!opacity-100',
  );

  const iconCls = 'w-6 h-6 sm:w-7 sm:h-7 text-gray-700 dark:text-gray-200';

  return (
    <>
      {/* Previous button — left side */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onPrevSlide();
        }}
        disabled={!canGoPrev}
        className={cn(
          btnBase,
          'left-3 sm:left-4',
          !canGoPrev && 'invisible',
        )}
        aria-label="Previous scene"
      >
        <ChevronLeft className={iconCls} />
      </button>

      {/* Next button — right side */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onNextSlide();
        }}
        disabled={!canGoNext}
        className={cn(
          btnBase,
          'right-3 sm:right-4',
          !canGoNext && 'invisible',
        )}
        aria-label="Next scene"
      >
        <ChevronRight className={iconCls} />
      </button>
    </>
  );
}
