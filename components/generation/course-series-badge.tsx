'use client';

/**
 * The badge a course card shows for a run that is one part of a course
 * series: "Part 2 of 5". `order` is on the run's own snapshot; `partCount`
 * is a series-wide fact fetched (and cached) separately, so the badge stays
 * blank for one render while that completes rather than block the card.
 */
import { Layers } from 'lucide-react';

import { useCourseSeriesPartCount } from '@/lib/generation-run-client/use-course-series';
import { useI18n } from '@/lib/hooks/use-i18n';

export function CourseSeriesBadge({
  seriesId,
  order,
}: {
  readonly seriesId: string;
  readonly order: number;
}) {
  const { t } = useI18n();
  const partCount = useCourseSeriesPartCount(seriesId);
  if (!partCount) return null;

  return (
    <span
      className="shrink-0 inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300"
      data-testid="course-series-badge"
    >
      <Layers className="size-3" aria-hidden="true" />
      {t('classroom.seriesBadge', { order, total: partCount })}
    </span>
  );
}
