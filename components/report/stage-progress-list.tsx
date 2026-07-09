'use client';

import { useI18n } from '@/lib/hooks/use-i18n';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import type { StageVM } from '@/lib/report/types';
import { StatStrip, type Stat } from './report-primitives';

const COMPLETE_THRESHOLD = 0.999;

export function StageProgressList({ stages }: { stages: StageVM[] }) {
  const { t } = useI18n();

  if (stages.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('learningReport.stages.empty')}</p>;
  }

  const summary: Stat[] = [
    {
      label: t('learningReport.stages.summaryStarted'),
      value: String(stages.filter((s) => s.started).length),
    },
    {
      label: t('learningReport.stages.summaryCompleted'),
      value: String(stages.filter((s) => (s.progressRatio ?? 0) >= COMPLETE_THRESHOLD).length),
    },
    {
      label: t('learningReport.stages.summaryScenes'),
      value: String(stages.reduce((sum, s) => sum + s.sceneCount, 0)),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <StatStrip items={summary} />
      <div className="flex flex-col gap-3">
      {stages.map((s) => {
        const ratio = s.progressRatio ?? 0;
        const value = Math.min(100, Math.round(ratio * 100));
        return (
          <div key={s.stageId} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <span className="line-clamp-1 font-medium leading-tight" title={s.name}>
                {s.name}
              </span>
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                {s.started ? `${value}%` : t('learningReport.stages.notStarted')}
              </span>
            </div>
            <Progress value={s.started ? value : 0} />
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {s.generationComplete && (
                <Badge className="border-amber-300/60 bg-amber-100 font-normal text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-400">
                  {t('learningReport.overview.completed')}
                </Badge>
              )}
              <span>
                {t('learningReport.stages.scenePosition', {
                  position: s.sceneCount,
                  total: s.plannedSceneCount,
                })}
              </span>
              {s.quizSceneCount > 0 && (
                <Badge variant="secondary" className="font-normal">
                  {t('learningReport.stages.quizBadge', {
                    done: s.quizSubmissionCount,
                    total: s.quizSceneCount,
                  })}
                </Badge>
              )}
              {s.avgQuizScoreRatio != null && (
                <Badge variant="secondary" className="font-normal">
                  {t('learningReport.stages.scoreBadge', {
                    pct: Math.round(s.avgQuizScoreRatio * 100),
                  })}
                </Badge>
              )}
              {s.chatSessionCount > 0 && (
                <Badge variant="secondary" className="font-normal">
                  {t('learningReport.stages.chatBadge', { count: s.chatSessionCount })}
                </Badge>
              )}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}
