'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { AchievementEmblem } from './achievement-emblems';
import type { Achievement } from '@/lib/report/types';

export function AchievementGrid({ achievements }: { achievements: Achievement[] }) {
  const { t, locale } = useI18n();
  const [selected, setSelected] = useState<Achievement | null>(null);

  const earnedCount = achievements.filter((a) => a.earned).length;
  const fmtDate = (ms: number | null): string =>
    ms == null ? '' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(ms));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t('learningReport.ach.summary', { earned: earnedCount, total: achievements.length })}
      </p>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-9">
        {achievements.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setSelected(a)}
            title={t(`learningReport.ach.${a.id}.title`)}
            className={cn(
              'group flex flex-col items-center gap-2 rounded-xl border bg-card p-3 text-center transition-all',
              'hover:shadow-sm hover:-translate-y-0.5',
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
            <span className="text-xs font-medium leading-tight line-clamp-2">
              {t(`learningReport.ach.${a.id}.title`)}
            </span>
          </button>
        ))}
      </div>

      <Dialog open={selected != null} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent>
          {selected && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      'flex h-12 w-12 items-center justify-center rounded-full shrink-0',
                      selected.earned
                        ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400'
                        : 'bg-muted text-muted-foreground grayscale',
                    )}
                  >
                    <AchievementEmblem id={selected.id} className="h-7 w-7" />
                  </span>
                  <div className="text-left">
                    <DialogTitle>{t(`learningReport.ach.${selected.id}.title`)}</DialogTitle>
                    <DialogDescription>
                      {t(`learningReport.ach.${selected.id}.desc`)}
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                {selected.earned
                  ? t('learningReport.ach.unlockedAt', { date: fmtDate(selected.earnedAt) })
                  : t('learningReport.ach.locked')}
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
