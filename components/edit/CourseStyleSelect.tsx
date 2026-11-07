'use client';

import { Palette } from 'lucide-react';
import { useStageStore } from '@/lib/store/stage';
import { COURSE_STYLES, DEFAULT_COURSE_STYLE, normalizeCourseStyle } from '@/configs/theme';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export function CourseStyleSelect({
  className,
  triggerClassName,
}: {
  readonly className?: string;
  readonly triggerClassName?: string;
}) {
  const stage = useStageStore((s) => s.stage);
  const setStageStyle = useStageStore((s) => s.setStageStyle);
  const currentStyle = normalizeCourseStyle(stage?.style || DEFAULT_COURSE_STYLE);

  return (
    <div className={cn('inline-flex items-center gap-1', className)}>
      <Select
        value={currentStyle}
        onValueChange={(value) => {
          setStageStyle(value);
        }}
      >
        <SelectTrigger
          data-testid="edit-course-style-select"
          className={cn(
            'h-7 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary/30 hover:text-foreground',
            triggerClassName,
          )}
        >
          <Palette className="mr-1 size-3 shrink-0" />
          <SelectValue placeholder="Style" />
        </SelectTrigger>
        <SelectContent align="start" className="min-w-[150px]">
          {Object.entries(COURSE_STYLES).map(([id, info]) => (
            <SelectItem key={id} value={id} className="text-xs">
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2 rounded-full border border-black/10 dark:border-white/20"
                  style={{ backgroundColor: info.tokens.background }}
                />
                <span>{info.label}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
