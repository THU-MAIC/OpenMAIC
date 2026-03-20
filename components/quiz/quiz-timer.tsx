'use client';

import { useEffect, useRef, useState } from 'react';
import { formatSeconds } from '@/lib/quiz/timer';

interface QuizTimerProps {
  durationMinutes: number;
  onExpire?: () => void;
  running?: boolean;
}

export function QuizTimer({ durationMinutes, onExpire, running = true }: QuizTimerProps) {
  const [remaining, setRemaining] = useState(() => durationMinutes * 60);
  const expiredRef = useRef(false);

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      if (document.hidden) return;
      setRemaining((value) => {
        const next = Math.max(0, value - 1);
        if (next === 0 && !expiredRef.current) {
          expiredRef.current = true;
          onExpire?.();
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [onExpire, running]);

  return (
    <div className="rounded-full border border-violet-200 bg-violet-50 px-4 py-2 text-sm font-semibold text-violet-700 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-300">
      {formatSeconds(remaining)}
    </div>
  );
}
