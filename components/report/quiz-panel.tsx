'use client';

import { useI18n } from '@/lib/hooks/use-i18n';
import type { ReportMetric, QuizVM } from '@/lib/report/types';
import { StatStrip, type Stat } from './report-primitives';
import { QuizChart } from './quiz-chart';

const pct = (r: number | null): string => (r == null ? '—' : `${Math.round(r * 100)}%`);

export function QuizPanel({ metric, quiz }: { metric: ReportMetric; quiz: QuizVM[] }) {
  const { t } = useI18n();

  if (quiz.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('learningReport.quiz.empty')}</p>;
  }

  const stats: Stat[] = [
    { label: t('learningReport.overview.quizAttempts'), value: String(metric.quizAttemptCount) },
    { label: t('learningReport.overview.quizStages'), value: String(metric.quizStageCount) },
    { label: t('learningReport.overview.avgScore'), value: pct(metric.avgQuizScoreRatio) },
    { label: t('learningReport.overview.bestScore'), value: pct(metric.bestQuizScoreRatio) },
    { label: t('learningReport.overview.perfect'), value: String(metric.perfectQuizAttemptCount) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <StatStrip items={stats} />
      <QuizChart quiz={quiz} />
    </div>
  );
}
