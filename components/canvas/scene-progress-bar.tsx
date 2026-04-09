'use client';

import { cn } from '@/lib/utils';
import type { SceneType } from '@/lib/types/stage';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { BookOpen, HelpCircle, MousePointer2, Cpu } from 'lucide-react';

export interface SceneProgressBarProps {
  readonly currentIndex: number;
  readonly scenes: ReadonlyArray<{ id: string; title: string; type: SceneType }>;
  readonly onGoToScene: (index: number) => void;
}

const sceneTypeIcon: Record<SceneType, React.ComponentType<{ className?: string }>> = {
  slide: BookOpen,
  quiz: HelpCircle,
  interactive: MousePointer2,
  pbl: Cpu,
};

export function SceneProgressBar({ currentIndex, scenes, onGoToScene }: SceneProgressBarProps) {
  if (scenes.length <= 1) return null;

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className={cn(
          'absolute bottom-0 left-0 right-0 z-[109]',
          'flex h-2 hover:h-4 transition-all duration-200',
          'bg-gray-100/60 dark:bg-gray-900/60 backdrop-blur-sm',
          'opacity-0 group-hover/canvas:opacity-100 transition-opacity duration-300',
        )}
      >
        {scenes.map((scene, idx) => {
          const Icon = sceneTypeIcon[scene.type] || BookOpen;
          const isActive = idx === currentIndex;
          const isCompleted = idx < currentIndex;

          return (
            <Tooltip key={scene.id}>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onGoToScene(idx);
                  }}
                  className={cn(
                    'flex-1 relative cursor-pointer transition-colors duration-150',
                    'border-r border-white/30 dark:border-gray-800/30 last:border-r-0',
                    isActive
                      ? 'bg-violet-500 dark:bg-violet-500'
                      : isCompleted
                        ? 'bg-violet-300/60 dark:bg-violet-700/50 hover:bg-violet-400/60 dark:hover:bg-violet-600/50'
                        : 'bg-gray-200/60 dark:bg-gray-700/40 hover:bg-gray-300/60 dark:hover:bg-gray-600/40',
                  )}
                  aria-label={`Go to scene ${idx + 1}: ${scene.title}`}
                />
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="flex items-center gap-1.5 text-xs max-w-[200px]"
              >
                <Icon className="w-3 h-3 shrink-0" />
                <span className="truncate">
                  {idx + 1}. {scene.title}
                </span>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
