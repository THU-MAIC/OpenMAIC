'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, BarChart3 } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Button } from '@/components/ui/button';
import { buildLearnerReport } from '@/lib/report/build-report';
import type { LearnerReport } from '@/lib/report/types';
import { ReportOverview } from './report-overview';
import { StageProgressList } from './stage-progress-list';
import { QuizPanel } from './quiz-panel';
import { ChatPanel } from './chat-panel';
import { AchievementSection } from './achievement-section';
import { PanelHeader } from './report-primitives';

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
    <div className="flex h-[100dvh] flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3 sm:px-6">
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
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('learningReport.loading')}
        </div>
      ) : report && report.isEmpty ? (
        <div className="flex-1 overflow-y-auto">
          <EmptyState onCreate={() => router.push('/')} />
        </div>
      ) : report ? (
        <div className="min-h-0 flex-1 lg:grid lg:grid-cols-4 lg:overflow-hidden">
          {/* Left 3/4 — four panels, plain vertical scroll, divided by rules. */}
          <main className="lg:col-span-3 lg:h-full lg:overflow-y-auto">
            <Panel
              title={t('learningReport.tabs.overview')}
              subtitle={t('learningReport.sections.overviewSub')}
            >
              <ReportOverview metric={report.metric} />
            </Panel>
            <Panel
              title={t('learningReport.tabs.stages')}
              subtitle={t('learningReport.sections.stagesSub')}
            >
              <StageProgressList stages={report.stages} />
            </Panel>
            <Panel
              title={t('learningReport.tabs.quiz')}
              subtitle={t('learningReport.sections.quizSub')}
            >
              <QuizPanel metric={report.metric} quiz={report.quiz} />
            </Panel>
            <Panel
              title={t('learningReport.tabs.chat')}
              subtitle={t('learningReport.sections.chatSub')}
            >
              <ChatPanel metric={report.metric} chat={report.chat} />
            </Panel>
          </main>

          {/* Right 1/4 — achievements, always present, independently scrollable. */}
          <aside className="border-t px-4 py-6 sm:px-6 lg:col-span-1 lg:h-full lg:overflow-hidden lg:border-l lg:border-t-0">
            <div className="mb-4">
              <PanelHeader title={t('learningReport.tabs.achievements')} />
            </div>
            <AchievementSection achievements={report.achievements} compact />
          </aside>
        </div>
      ) : null}
    </div>
  );
}

/** One report section — plain block separated from the next by a bottom rule. */
function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5 border-b px-4 py-8 last:border-b-0 sm:px-6 lg:px-8">
      <PanelHeader title={title} subtitle={subtitle} />
      {children}
    </section>
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
