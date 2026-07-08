'use client';

import { useI18n } from '@/lib/hooks/use-i18n';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import type { StageVM } from '@/lib/report/types';

export function StageProgressList({ stages }: { stages: StageVM[] }) {
  const { t } = useI18n();

  if (stages.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('learningReport.stages.empty')}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {stages.map((s) => {
        const ratio = s.progressRatio ?? 0;
        const value = Math.min(100, Math.round(ratio * 100));
        return (
          <div key={s.stageId} className="rounded-xl border bg-card p-4 flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
              <span className="font-medium leading-tight line-clamp-1" title={s.name}>
                {s.name}
              </span>
              <span className="text-sm text-muted-foreground tabular-nums shrink-0">
                {s.started ? `${value}%` : t('learningReport.stages.notStarted')}
              </span>
            </div>
            <Progress value={s.started ? value : 0} />
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {t('learningReport.stages.scenePosition', {
                  position: s.currentScenePosition ?? 0,
                  total: s.sceneCount,
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
  );
}
