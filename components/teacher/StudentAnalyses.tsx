'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { FileSearch, LoaderCircle, Plus, RefreshCw, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getTeacherAnalysisCopy } from '@/lib/i18n/teacher-analysis';
import type { TeacherAnalysis } from '@/lib/teacher/analysis';
import type { SettingsSection } from '@/lib/types/settings';
import { cn } from '@/lib/utils';
import { teacherRequest } from './student-ui';
import { analysisCollectionUrl, analysisErrorMessage } from './analysis-ui';
import { AnalysisComposer } from './AnalysisComposer';
import { AnalysisEditor } from './AnalysisEditor';

const SettingsDialog = dynamic(
  () => import('@/components/settings').then((module) => module.SettingsDialog),
  { ssr: false },
);

interface StudentAnalysesProps {
  profileId: string;
  nickname: string;
  locale: string;
  archived?: boolean;
}

/** Key the entire working state so changing student cannot retain another draft. */
export function StudentAnalyses(props: StudentAnalysesProps) {
  return <StudentAnalysesContent key={props.profileId} {...props} />;
}

function StudentAnalysesContent({
  profileId,
  nickname,
  locale,
  archived = false,
}: StudentAnalysesProps) {
  const copy = getTeacherAnalysisCopy(locale);
  const [analyses, setAnalyses] = useState<TeacherAnalysis[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const sequence = useRef(0);
  const listController = useRef<AbortController | null>(null);
  const selected = analyses.find((analysis) => analysis.analysisId === selectedId) ?? analyses[0];

  const load = useCallback(async () => {
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    const currentSequence = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const response = await teacherRequest<{ analyses: TeacherAnalysis[] }>(
        analysisCollectionUrl(profileId),
        { signal: controller.signal },
      );
      if (response.analyses.some((analysis) => analysis.profileId !== profileId))
        throw new Error('Unexpected student analyses');
      if (!controller.signal.aborted && currentSequence === sequence.current)
        setAnalyses(response.analyses);
    } catch (failure) {
      if (!controller.signal.aborted && currentSequence === sequence.current)
        setError(analysisErrorMessage(failure, copy));
    } finally {
      if (!controller.signal.aborted && currentSequence === sequence.current) setLoading(false);
    }
  }, [profileId, copy]);

  useEffect(() => {
    void load();
    return () => {
      listController.current?.abort();
    };
  }, [load]);

  function acceptAnalysis(analysis: TeacherAnalysis) {
    if (analysis.profileId !== profileId) return;
    sequence.current++;
    listController.current?.abort();
    setLoading(false);
    setAnalyses((current) =>
      [analysis, ...current.filter((item) => item.analysisId !== analysis.analysisId)].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt),
      ),
    );
    setSelectedId(analysis.analysisId);
    setCreating(false);
    setError('');
  }

  return (
    <section
      className="min-w-0 border-t py-6"
      aria-label={copy.title}
      data-testid="teacher-student-analyses"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <FileSearch className="size-4" />
          {copy.title}
        </h3>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={copy.refresh}
                disabled={loading}
                onClick={() => void load()}
              >
                <RefreshCw className={loading ? 'animate-spin' : ''} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copy.refresh}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={copy.settings}
                onClick={() => setSettingsSection('providers')}
              >
                <Settings2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{copy.settings}</TooltipContent>
          </Tooltip>
          {!archived && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="teacher-analysis-new"
              onClick={() => setCreating(true)}
            >
              <Plus />
              {copy.create}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-destructive mt-4 text-sm leading-6">
          {error}
        </p>
      )}
      {loading && !analyses.length ? (
        <p role="status" className="text-muted-foreground mt-4 flex items-center gap-2 text-sm">
          <LoaderCircle className="size-4 animate-spin" />
          {copy.loading}
        </p>
      ) : !analyses.length && !error ? (
        <p className="text-muted-foreground mt-4 text-sm">{copy.empty}</p>
      ) : null}
      {analyses.length > 0 && (
        <ul
          className="my-4 max-h-64 min-w-0 divide-y overflow-y-auto border-y"
          aria-label={copy.history}
        >
          {analyses.map((analysis) => (
            <li key={analysis.analysisId}>
              <button
                type="button"
                className={cn(
                  'w-full min-w-0 border-l-2 px-3 py-3 text-left transition-colors',
                  analysis.analysisId === selected?.analysisId
                    ? 'border-emerald-600 bg-muted dark:border-emerald-400'
                    : 'hover:bg-muted/50 border-transparent',
                )}
                aria-pressed={analysis.analysisId === selected?.analysisId}
                onClick={() => setSelectedId(analysis.analysisId)}
              >
                <span className="block break-words text-sm font-medium [overflow-wrap:anywhere]">
                  {analysis.request.title}
                </span>
                <span className="text-muted-foreground mt-1 block text-xs leading-5">
                  {analysis.request.workDate} · {analysis.request.subject} ·{' '}
                  {copy.workKinds[analysis.request.workKind]}
                </span>
                <span className="text-muted-foreground mt-1 block text-xs">
                  {copy[analysis.status]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <AnalysisEditor
          key={selected.analysisId}
          analysis={selected}
          copy={copy}
          readOnly={archived}
          onSaved={acceptAnalysis}
        />
      )}
      {creating && (
        <AnalysisComposer
          profileId={profileId}
          nickname={nickname}
          copy={copy}
          onClose={() => {
            setCreating(false);
            void load();
          }}
          onSaved={acceptAnalysis}
          onSettings={setSettingsSection}
        />
      )}
      {settingsSection && (
        <SettingsDialog
          open
          initialSection={settingsSection}
          onOpenChange={(open) => !open && setSettingsSection(null)}
        />
      )}
    </section>
  );
}
