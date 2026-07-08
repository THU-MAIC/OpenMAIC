'use client';

import { useState } from 'react';
import { LayoutGrid, Sparkles } from 'lucide-react';
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
import { AchievementGrid } from './achievement-grid';
import { AchievementConstellation } from './achievement-constellation';
import type { Achievement } from '@/lib/report/types';

type View = 'grid' | 'star';

export function AchievementSection({ achievements }: { achievements: Achievement[] }) {
  const { t, locale } = useI18n();
  const [view, setView] = useState<View>('grid');
  const [selected, setSelected] = useState<Achievement | null>(null);

  const earnedCount = achievements.filter((a) => a.earned).length;
  const fmtDate = (ms: number | null): string =>
    ms == null ? '' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(ms));

  const tabs: { key: View; label: string; icon: typeof LayoutGrid }[] = [
    { key: 'grid', label: t('learningReport.views.grid'), icon: LayoutGrid },
    { key: 'star', label: t('learningReport.views.star'), icon: Sparkles },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t('learningReport.ach.summary', { earned: earnedCount, total: achievements.length })}
        </p>
        <div className="flex items-center gap-1 rounded-lg border bg-muted/40 p-0.5">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setView(tab.key)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  view === tab.key
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {view === 'grid' ? (
        <AchievementGrid achievements={achievements} onSelect={setSelected} />
      ) : (
        <AchievementConstellation achievements={achievements} onSelect={setSelected} />
      )}

      <Dialog open={selected != null} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent>
          {selected && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      'flex h-12 w-12 shrink-0 items-center justify-center rounded-full',
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
