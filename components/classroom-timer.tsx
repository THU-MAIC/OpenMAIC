'use client';

import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { Clock } from 'lucide-react';

interface ClassroomTimerProps {
  currentSceneIndex: number;
  totalScenes: number;
  className?: string;
}

export function ClassroomTimer({ currentSceneIndex, totalScenes, className }: ClassroomTimerProps) {
  // calculate slides remaining (including the one currently being viewed)
  const slidesRemaining = Math.max(0, totalScenes - currentSceneIndex);

  // approximate minutes left: 1.5 minutes per remaining slide, rounded up
  const minutesLeft = Math.ceil(slidesRemaining * 1.5);

  // progress bar reflects how far along the course we are (0 to 1)
  const progress = totalScenes > 0 ? (currentSceneIndex / totalScenes) : 0;

  const radius = 18;
  const strokeDasharray = 2 * Math.PI * radius;
  const strokeDashoffset = strokeDasharray * (1 - progress);

  return (
    <div
      className={cn(
        'flex items-center gap-3 bg-white/70 dark:bg-gray-900/40 backdrop-blur-xl px-4 py-2.5 rounded-2xl shadow-[0_8px_32px_-4px_rgba(0,0,0,0.1)] border border-white/40 dark:border-gray-800/20 active:scale-95 transition-transform duration-200',
        className
      )}
    >
      <div className="relative w-10 h-10 flex items-center justify-center">
        {/* SVG Circles */}
        <svg className="absolute inset-0 w-full h-full -rotate-90">
          {/* Background Track */}
          <circle
            cx="20"
            cy="20"
            r={radius}
            className="stroke-gray-100/50 dark:stroke-gray-800/50 fill-none"
            strokeWidth="3.5"
          />
          {/* Progress Indicator */}
          <motion.circle
            cx="20"
            cy="20"
            r={radius}
            className="stroke-primary fill-none"
            strokeWidth="3.5"
            strokeLinecap="round"
            initial={{ strokeDashoffset: strokeDasharray }}
            animate={{ strokeDashoffset }}
            transition={{ duration: 1, ease: 'easeInOut' }}
            style={{ strokeDasharray }}
          />
        </svg>
        <Clock className="w-4 h-4 text-primary relative z-10" />
      </div>

      <div className="flex flex-col">
        <span className="text-[10px] uppercase tracking-wider font-extrabold text-gray-400 dark:text-gray-500 leading-none mb-1">
          Time Left
        </span>
        <span className="text-base font-mono font-black text-gray-800 dark:text-gray-100 tabular-nums leading-tight tracking-tight">
          {minutesLeft}m
        </span>
      </div>
    </div>
  );
}
