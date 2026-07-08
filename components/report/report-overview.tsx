'use client';

import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { ReportMetric } from '@/lib/report/types';

const pct = (r: number | null): string => (r == null ? '—' : `${Math.round(r * 100)}%`);
const num = (n: number): string => String(n);

interface Tile {
  label: string;
  value: string;
  hint?: string;
}

export function ReportOverview({ metric }: { metric: ReportMetric }) {
  const { t } = useI18n();

  const groups: { title: string; tiles: Tile[] }[] = [
    {
      title: t('learningReport.overview.progress'),
      tiles: [
        { label: t('learningReport.overview.stageCount'), value: num(metric.stageCount) },
        { label: t('learningReport.overview.started'), value: num(metric.startedStageCount) },
        {
          label: t('learningReport.overview.completed'),
          value: num(metric.completedStageCountProxy),
        },
        { label: t('learningReport.overview.avgProgress'), value: pct(metric.avgProgressRatio) },
        { label: t('learningReport.overview.maxProgress'), value: pct(metric.maxProgressRatio) },
      ],
    },
    {
      title: t('learningReport.overview.quiz'),
      tiles: [
        { label: t('learningReport.overview.quizAttempts'), value: num(metric.quizAttemptCount) },
        { label: t('learningReport.overview.avgScore'), value: pct(metric.avgQuizScoreRatio) },
        { label: t('learningReport.overview.bestScore'), value: pct(metric.bestQuizScoreRatio) },
        { label: t('learningReport.overview.perfect'), value: num(metric.perfectQuizAttemptCount) },
      ],
    },
    {
      title: t('learningReport.overview.chat'),
      tiles: [
        { label: t('learningReport.overview.sessions'), value: num(metric.chatSessionCount) },
        { label: t('learningReport.overview.qa'), value: num(metric.qaSessionCount) },
        { label: t('learningReport.overview.lecture'), value: num(metric.lectureSessionCount) },
        { label: t('learningReport.overview.messages'), value: num(metric.totalChatMessageCount) },
      ],
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <section key={g.title} className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-muted-foreground">{g.title}</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {g.tiles.map((tile) => (
              <StatTile key={tile.label} tile={tile} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function StatTile({ tile }: { tile: Tile }) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-card p-4 flex flex-col gap-1',
        'transition-colors hover:bg-accent/40',
      )}
    >
      <span className="text-xs text-muted-foreground">{tile.label}</span>
      <span className="text-2xl font-semibold tabular-nums">{tile.value}</span>
      {tile.hint && <span className="text-[11px] text-muted-foreground">{tile.hint}</span>}
    </div>
  );
}
