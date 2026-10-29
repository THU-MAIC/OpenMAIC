'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  FileText,
  Layers,
  MessageSquare,
  Sparkles,
  Target,
  X,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { reportConversationMessages, type LearningReport } from '@/lib/pbl/v3/report';
import { TextBlock } from '@/components/workbench/chat/text-block';
import { sandboxErrorMessage } from '@/lib/sandbox/error-message';

/** Report reads never prepare an environment; the same surface opens from hero or workbench. */
export function ProjectReport({
  studyId,
  title,
  open,
  onClose,
  onWorkbench,
}: {
  studyId: string;
  title: string;
  open: boolean;
  onClose: () => void;
  onWorkbench: () => void;
}) {
  const { t } = useI18n();
  const [report, setReport] = useState<LearningReport | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const surface = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  }, [onClose]);
  const load = useCallback(
    async (method: 'GET' | 'POST', signal: AbortSignal) => {
      setPending(true);
      setError('');
      try {
        const response = await fetch(`/api/pbl/v3/report?id=${encodeURIComponent(studyId)}`, {
          method,
          headers: { 'x-openmaic-sandbox': '1', 'content-type': 'application/json' },
          cache: 'no-store',
          signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(sandboxErrorMessage(data.error));
        if (!signal.aborted) setReport(data);
        return data as LearningReport;
      } catch (e) {
        if (!signal.aborted)
          setError(e instanceof Error ? e.message : t('pblV3.reportCopy.failed'));
      } finally {
        if (!signal.aborted) setPending(false);
      }
    },
    [studyId, t],
  );
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    controller.current = abort;
    setReport(null);
    // Show facts immediately; a deliberate report opening may generate its saved analysis.
    void load('GET', abort.signal).then((data) => {
      if (!abort.signal.aborted && data?.analysis?.status === 'not_generated')
        void load('POST', abort.signal);
    });
    return () => abort.abort();
  }, [open, studyId, load]);
  useEffect(() => {
    if (!open || pending || error || report?.analysis?.status !== 'generating') return;
    const timer = setTimeout(() => {
      if (controller.current) void load('GET', controller.current.signal);
    }, 2000);
    return () => clearTimeout(timer);
  }, [open, pending, error, report, load]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    surface.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open, studyId]);
  if (!open) return null;
  const sourceId = (id: string) => `report-source-${studyId}-${id.replaceAll(':', '-')}`;
  const cite = (id: string) => {
    const target = document.getElementById(sourceId(id));
    if (target instanceof HTMLDetailsElement) target.open = true;
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const summary = report?.summary;
  const metrics = summary
    ? [
        {
          label: 'completedMilestones',
          value: `${summary.completedMilestones}/${summary.totalMilestones}`,
          icon: Layers,
        },
        {
          label: 'completedSteps',
          value: `${summary.completedSteps}/${summary.totalSteps}`,
          icon: CheckCircle2,
        },
        { label: 'learnerTurns', value: report?.facts?.learnerTurns ?? 0, icon: MessageSquare },
        { label: 'concepts', value: summary.concepts.length, icon: Sparkles },
      ]
    : [];
  const button =
    'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50';
  const stepLabel = (step: string) => t(`pblV3.journey.steps.${step}`);
  return (
    <section
      ref={surface}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={t('pblV3.report')}
      data-testid="pbl-project-report"
      className="absolute inset-0 z-40 overflow-auto bg-background text-foreground outline-none"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close.current();
        }
        if (event.key === 'Tab') {
          const nodes = [
            ...(surface.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), a[href], summary, [tabindex="0"]',
            ) ?? []),
          ].filter((node) => node.getClientRects().length > 0);
          const first = nodes[0],
            last = nodes.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first || document.activeElement === surface.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <nav className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background/95 py-3 pl-4 pr-16 backdrop-blur sm:pl-8 sm:pr-20">
        <button className={button} onClick={onWorkbench}>
          <ArrowLeft size={15} />
          {t('pblV3.reportCopy.viewWorkbench')}
        </button>
        <span className="hidden text-xs font-medium text-muted-foreground sm:block">
          {t('pblV3.report')}
        </span>
        <button
          className="rounded-lg p-2 hover:bg-muted"
          aria-label={t('pblV3.reportCopy.close')}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </nav>
      <div className="mx-auto max-w-6xl space-y-9 px-4 py-6 pb-12 sm:px-8 sm:py-9">
        <header className="relative isolate overflow-hidden rounded-3xl border border-violet-400/20 bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-900 px-6 py-8 text-white sm:px-9 sm:py-10">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-16 -top-24 -z-10 size-80 rounded-full bg-violet-400/20 blur-3xl"
          />
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-violet-300/30 bg-white/5 px-3 py-1 text-xs font-medium text-violet-200">
            <CheckCircle2 size={14} />
            {t('pblV3.reportCopy.completedTitle')}
          </p>
          <p className="max-w-3xl text-sm text-indigo-200">{title}</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            {t('pblV3.report')}
          </h2>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-indigo-100/80">
            {t('pblV3.reportCopy.subtitle')}
          </p>
          {!!metrics.length && (
            <dl className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
              {metrics.map(({ label, value, icon: Icon }) => (
                <div
                  key={label}
                  className="rounded-2xl border border-white/15 bg-white/5 px-4 py-4 backdrop-blur"
                >
                  <dt className="flex items-center gap-2 text-xs text-indigo-200">
                    <Icon size={14} />
                    {t(`pblV3.reportCopy.${label}`)}
                  </dt>
                  <dd className="mt-3 font-mono text-3xl font-semibold tracking-tight text-white">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </header>
        {pending && !report && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('pblV3.loading')}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm"
          >
            {error}
          </p>
        )}
        {report && (
          <>
            {!!summary?.skills.length && (
              <section aria-label={t('pblV3.reportCopy.skills')}>
                <div className="mb-4 flex items-center gap-2">
                  <Target size={18} className="text-violet-500" />
                  <h3 className="text-xl font-semibold">{t('pblV3.reportCopy.skills')}</h3>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {summary.skills.map((skill, i) => (
                    <article
                      key={skill.id}
                      className="flex items-start gap-3 rounded-2xl border bg-gradient-to-br from-violet-500/5 to-transparent p-4"
                    >
                      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 font-mono text-sm text-violet-500">
                        0{i + 1}
                      </span>
                      <div>
                        <h4 className="text-sm font-semibold">
                          {t(`pblV3.reportCopy.skillLabels.${skill.id}`)}
                        </h4>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {skill.milestoneIds
                            .map((id) => report.milestones.find((m) => m.id === id)?.title)
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </div>
                    </article>
                  ))}
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  {t('pblV3.reportCopy.practiceNotice')}
                </p>
              </section>
            )}
            {!!summary?.concepts.length && (
              <section
                aria-label={t('pblV3.reportCopy.concepts')}
                className="rounded-2xl border bg-muted/30 p-5"
              >
                <h3 className="mb-3 text-sm font-semibold">{t('pblV3.reportCopy.concepts')}</h3>
                <div className="flex flex-wrap gap-2">
                  {summary.concepts.map((c) => (
                    <span key={c} className="rounded-full border bg-background px-3 py-1.5 text-xs">
                      {c}
                    </span>
                  ))}
                </div>
              </section>
            )}
            <section className="space-y-4" aria-label={t('pblV3.reportCopy.analysis')}>
              <div className="flex items-center gap-2">
                <Sparkles size={18} className="text-violet-500" />
                <h3 className="text-xl font-semibold">{t('pblV3.reportCopy.analysis')}</h3>
              </div>
              {(pending || report.analysis?.status === 'generating') && (
                <p
                  role="status"
                  className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground"
                >
                  {t('pblV3.reportCopy.generating')}
                </p>
              )}
              {!pending && report.analysis?.status === 'failed' && (
                <p role="status" className="text-sm text-muted-foreground">
                  {t('pblV3.reportCopy.failed')}
                </p>
              )}
              {report.analysis?.omitted && (
                <p className="text-xs text-muted-foreground">{t('pblV3.reportCopy.omitted')}</p>
              )}
              <div className="grid gap-4 lg:grid-cols-2">
                {report.analysis?.findings.map((f, i) => (
                  <article
                    key={i}
                    className={`rounded-2xl border p-5 ${f.category === 'journey' ? 'bg-indigo-500/5 lg:col-span-2' : 'bg-background'}`}
                  >
                    <p className="mb-2 text-xs font-semibold text-violet-500">
                      {t(`pblV3.reportCopy.${f.category}`)}
                    </p>
                    <h4 className="text-lg font-semibold leading-snug">{f.title}</h4>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                      {f.detail}
                    </p>
                    {f.quote && (
                      <blockquote className="my-4 rounded-r-lg border-l-2 border-violet-400 bg-violet-500/5 px-4 py-3 text-sm leading-relaxed">
                        {f.quote}
                      </blockquote>
                    )}
                    <div className="mt-4 flex flex-wrap gap-3">
                      {f.evidence.map((id, j) => (
                        <button
                          key={id}
                          className="inline-flex items-center gap-1 text-xs font-medium text-violet-500 underline-offset-4 hover:underline"
                          onClick={() => cite(id)}
                        >
                          {t('pblV3.reportCopy.source')} {j + 1}
                          <ArrowUpRight size={12} />
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </section>
            <section
              aria-label={t('pblV3.reportCopy.facts')}
              className="rounded-2xl border bg-muted/20 p-5"
            >
              <h3 className="text-lg font-semibold">{t('pblV3.reportCopy.facts')}</h3>
              <p className="mb-4 mt-1 text-xs text-muted-foreground">
                {t('pblV3.reportCopy.countNotice')}
              </p>
              <dl className="grid grid-cols-2 gap-5 sm:grid-cols-4">
                {Object.entries(report.facts ?? {}).map(([key, value]) => (
                  <div key={key}>
                    <dt className="text-xs text-muted-foreground">
                      {t(`pblV3.reportCopy.${key}`)}
                    </dt>
                    <dd className="mt-1 font-mono text-2xl font-semibold">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <section aria-label={t('pblV3.reportCopy.journey')}>
              <h3 className="mb-4 text-xl font-semibold">{t('pblV3.reportCopy.journey')}</h3>
              <ol className="space-y-4">
                {report.milestones.map((m, i) => (
                  <li key={m.id} className="rounded-2xl border p-5">
                    <div className="mb-4 flex items-center gap-3">
                      <span className="flex size-8 items-center justify-center rounded-full bg-violet-500/10 font-mono text-sm text-violet-500">
                        {i + 1}
                      </span>
                      <h4 className="font-semibold">{m.title}</h4>
                      {m.status === 'completed' && (
                        <CheckCircle2 size={17} className="ml-auto shrink-0 text-emerald-500" />
                      )}
                    </div>
                    <div className="mb-4 flex flex-wrap gap-2">
                      {m.stages.map((step, j) => (
                        <span
                          key={j}
                          className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                        >
                          {j + 1} · {stepLabel(step)}
                        </span>
                      ))}
                    </div>
                    {report.outcomes
                      ?.filter((o) => o.milestoneId === m.id)
                      .map((o) => (
                        <div key={o.milestoneId} className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                          <span>
                            {t('pblV3.stageNames.tests')}:{' '}
                            {o.tests
                              ? t(`pblV3.testResult.${o.tests}`)
                              : t('pblV3.journey.noTests')}
                          </span>
                          <span>
                            {t('pblV3.stageNames.quiz')}:{' '}
                            {o.quiz ? `${o.quiz.score}/${o.quiz.total}` : t('pblV3.journey.noQuiz')}
                          </span>
                          <span>
                            {t(
                              o.reflected
                                ? 'pblV3.journey.reflected'
                                : 'pblV3.journey.notReflected',
                            )}
                          </span>
                        </div>
                      ))}
                  </li>
                ))}
              </ol>
            </section>
            <div className="border-t pt-7">
              <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
                {t('pblV3.evidenceReportNotice')}
              </p>
              {report.truncated && (
                <p role="status" className="mb-4 text-xs text-muted-foreground">
                  {t('pblV3.truncatedEvidence')}
                </p>
              )}
              <section className="space-y-2">
                <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold">
                  <FileText size={17} />
                  {t('pblV3.reportEvidence')}
                </h3>
                {report.evidence.map((e) => (
                  <details
                    id={sourceId(`event:${e.sequence}`)}
                    key={e.sequence}
                    className="rounded-xl border p-3"
                  >
                    <summary className="cursor-pointer text-sm">
                      {report.milestones.find((m) => m.id === e.milestoneId)?.title} ·{' '}
                      {t(`pblV3.evidenceKinds.${e.kind.replaceAll('.', '_')}`)}
                      {e.version ? ` · ${e.version}` : ''}
                    </summary>
                    {e.truncated && <p className="mt-2 text-xs">{t('pblV3.truncatedEvidence')}</p>}
                    <div className="mt-3 max-h-80 overflow-auto text-sm">
                      <TextBlock text={e.detail} />
                    </div>
                  </details>
                ))}
              </section>
              <section className="mt-7 space-y-2">
                <h3 className="mb-3 text-lg font-semibold">{t('pblV3.reportConversations')}</h3>
                {reportConversationMessages(report).map((m) => (
                  <details
                    id={sourceId(m.id)}
                    key={m.id}
                    className="min-w-0 rounded-xl border p-3 [overflow-wrap:anywhere]"
                  >
                    <summary className="cursor-pointer text-sm">
                      {m.role === 'learner' ? t('pblV3.learner') : t(`pblV3.roles.${m.role}`)} ·{' '}
                      {report.milestones.find((x) => x.id === m.milestone)?.title ??
                        report.project.title}
                    </summary>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{m.text}</p>
                  </details>
                ))}
              </section>
            </div>
          </>
        )}
        {(error || report?.analysis?.canRetry) && !pending && (
          <button
            className={button}
            onClick={() => {
              if (controller.current) void load('POST', controller.current.signal);
            }}
          >
            {t('pblV3.reportCopy.retry')}
          </button>
        )}
      </div>
    </section>
  );
}
