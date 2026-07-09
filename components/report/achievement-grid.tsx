'use client';

import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { ACH_GROUPS } from '@/lib/report/achievements';
import { AchievementEmblem } from './achievement-emblems';
import type { Achievement } from '@/lib/report/types';

/** Grid view — badges grouped into course / quiz / chat / explore sections. */
export function AchievementGrid({
  achievements,
  onSelect,
  compact = false,
}: {
  achievements: Achievement[];
  onSelect: (a: Achievement) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={cn('flex flex-col', compact ? 'gap-3' : 'gap-6')}>
      {ACH_GROUPS.map((g) => {
        const items = achievements.filter((a) => a.group === g);
        if (items.length === 0) return null;
        return (
          <section key={g} className={cn('flex flex-col', compact ? 'gap-1.5' : 'gap-3')}>
            <h4 className="text-xs font-semibold text-muted-foreground">
              {t(`learningReport.groups.${g}`)}
            </h4>
            <div
              className={cn(
                'grid',
                compact
                  ? 'grid-cols-4 gap-2'
                  : 'grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7',
              )}
            >
              {items.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onSelect(a)}
                  title={t(`learningReport.ach.${a.id}.title`)}
                  className={cn(
                    'group flex flex-col items-center border bg-card text-center transition-all',
                    'hover:-translate-y-0.5 hover:shadow-sm',
                    compact
                      ? 'aspect-square w-full max-w-[56px] justify-center justify-self-center gap-0 rounded-xl p-2'
                      : 'gap-2 rounded-xl p-3',
                    a.earned ? 'border-amber-300/60 dark:border-amber-500/30' : 'opacity-60',
                  )}
                >
                  <span
                    className={cn(
                      'flex items-center justify-center rounded-full',
                      compact ? 'aspect-square w-full' : 'h-11 w-11',
                      a.earned
                        ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400'
                        : 'bg-muted text-muted-foreground grayscale',
                    )}
                  >
                    <AchievementEmblem id={a.id} className={compact ? 'h-1/2 w-1/2' : 'h-6 w-6'} />
                  </span>
                  {!compact && (
                    <span className="line-clamp-2 text-xs font-medium leading-tight">
                      {t(`learningReport.ach.${a.id}.title`)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
