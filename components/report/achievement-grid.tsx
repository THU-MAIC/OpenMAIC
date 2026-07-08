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
}: {
  achievements: Achievement[];
  onSelect: (a: Achievement) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-6">
      {ACH_GROUPS.map((g) => {
        const items = achievements.filter((a) => a.group === g);
        if (items.length === 0) return null;
        return (
          <section key={g} className="flex flex-col gap-3">
            <h4 className="text-sm font-semibold text-muted-foreground">
              {t(`learningReport.groups.${g}`)}
            </h4>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7">
              {items.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onSelect(a)}
                  title={t(`learningReport.ach.${a.id}.title`)}
                  className={cn(
                    'group flex flex-col items-center gap-2 rounded-xl border bg-card p-3 text-center transition-all',
                    'hover:-translate-y-0.5 hover:shadow-sm',
                    a.earned ? 'border-amber-300/60 dark:border-amber-500/30' : 'opacity-60',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-11 w-11 items-center justify-center rounded-full',
                      a.earned
                        ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400'
                        : 'bg-muted text-muted-foreground grayscale',
                    )}
                  >
                    <AchievementEmblem id={a.id} className="h-6 w-6" />
                  </span>
                  <span className="line-clamp-2 text-xs font-medium leading-tight">
                    {t(`learningReport.ach.${a.id}.title`)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
