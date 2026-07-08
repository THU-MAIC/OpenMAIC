'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, BarChart3 } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { buildLearnerReport } from '@/lib/report/build-report';
import type { LearnerReport } from '@/lib/report/types';
import { ReportOverview } from './report-overview';
import { StageProgressList } from './stage-progress-list';
import { QuizChart } from './quiz-chart';
import { ChatChart } from './chat-chart';
import { AchievementSection } from './achievement-section';

export function ReportView() {
  const { t } = useI18n();
  const router = useRouter();
  const [report, setReport] = useState<LearnerReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await buildLearnerReport();
        if (alive) setReport(r);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:py-12">
      <header className="mb-8 flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push('/')}
          aria-label={t('learningReport.back')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{t('learningReport.title')}</h1>
        </div>
      </header>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('learningReport.loading')}
        </div>
      ) : report && report.isEmpty ? (
        <EmptyState onCreate={() => router.push('/')} />
      ) : report ? (
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="mb-6 flex-wrap">
            <TabsTrigger value="overview">{t('learningReport.tabs.overview')}</TabsTrigger>
            <TabsTrigger value="stages">{t('learningReport.tabs.stages')}</TabsTrigger>
            <TabsTrigger value="quiz">{t('learningReport.tabs.quiz')}</TabsTrigger>
            <TabsTrigger value="chat">{t('learningReport.tabs.chat')}</TabsTrigger>
            <TabsTrigger value="achievements">{t('learningReport.tabs.achievements')}</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <ReportOverview metric={report.metric} />
          </TabsContent>
          <TabsContent value="stages">
            <StageProgressList stages={report.stages} />
          </TabsContent>
          <TabsContent value="quiz">
            <QuizChart quiz={report.quiz} />
          </TabsContent>
          <TabsContent value="chat">
            <ChatChart chat={report.chat} />
          </TabsContent>
          <TabsContent value="achievements">
            <AchievementSection achievements={report.achievements} />
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <BarChart3 className="h-10 w-10 text-muted-foreground/50" />
      <p className="text-sm text-muted-foreground">{t('learningReport.emptyState')}</p>
      <Button onClick={onCreate}>{t('learningReport.emptyStateCta')}</Button>
    </div>
  );
}
