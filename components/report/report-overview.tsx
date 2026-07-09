'use client';

import { useI18n } from '@/lib/hooks/use-i18n';
import type { ReportMetric } from '@/lib/report/types';
import { StatTile, type Stat } from './report-primitives';

const pct = (r: number | null): string => (r == null ? '—' : `${Math.round(r * 100)}%`);
const num = (n: number): string => String(n);

export function ReportOverview({ metric }: { metric: ReportMetric }) {
  const { t, locale } = useI18n();

  const lastActive =
    metric.lastActivityAt == null
      ? t('learningReport.overview.neverActive')
      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
          new Date(metric.lastActivityAt),
        );

  const groups: { title: string; tiles: Stat[] }[] = [
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
      title: t('learningReport.overview.scenes'),
      tiles: [
        { label: t('learningReport.overview.totalScenes'), value: num(metric.totalSceneCount) },
        { label: t('learningReport.sceneTypes.slide'), value: num(metric.slideSceneCount) },
        { label: t('learningReport.sceneTypes.quiz'), value: num(metric.quizSceneCount) },
        { label: t('learningReport.sceneTypes.pbl'), value: num(metric.pblSceneCount) },
        { label: t('learningReport.sceneTypes.interactive'), value: num(metric.interactiveSceneCount) },
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
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-xl border bg-card px-4 py-3">
        <span className="text-xs text-muted-foreground">
          {t('learningReport.overview.lastActivity')}
        </span>
        <span className="text-sm font-medium">{lastActive}</span>
      </div>

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
