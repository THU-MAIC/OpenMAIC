'use client';

import { CheckCircle2, LoaderCircle } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { ClassroomPackageProgress } from '@/lib/import/classroom-package';

export interface ImportProgressProps {
  phase: ClassroomPackageProgress['phase'];
  progress: number;
  message?: string;
  className?: string;
}

export function ImportProgress({ phase, progress, message, className }: ImportProgressProps) {
  const complete = phase === 'ready' || phase === 'done';
  const safeProgress = Math.max(0, Math.min(100, progress));

  return (
    <div
      className={cn('rounded-xl border bg-muted/35 p-4', className)}
      role="status"
      aria-live="polite"
      aria-label={message || '正在处理课程包'}
    >
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        {complete ? (
          <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" />
        ) : (
          <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate">{message || '正在处理课程包…'}</span>
        <span className="text-muted-foreground tabular-nums">{Math.round(safeProgress)}%</span>
      </div>
      <Progress value={safeProgress} className="h-2" />
    </div>
  );
}
