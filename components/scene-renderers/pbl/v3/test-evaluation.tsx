'use client';
import { CircleAlert, CheckCircle2, ListChecks, LoaderCircle, XCircle } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LearningView } from '@/lib/pbl/v3/types';

/** OpenPBL's verdict + public diagnostics card, adapted to the host's tokens and i18n. */
export function TestEvaluation({
  view,
  mode,
  collectionFailed = false,
}: {
  view: LearningView;
  mode: 'summary' | 'details';
  collectionFailed?: boolean;
}) {
  const { t } = useI18n();
  const result = view.state.collected[view.state.position.milestoneId ?? '']?.tests;
  // A newer pending run always takes precedence over an earlier saved pass.
  const phase = view.evaluation
    ? collectionFailed
      ? 'unavailable'
      : ['starting', 'running'].includes(view.evaluation.state)
        ? 'running'
        : 'collecting'
    : (result?.status ?? 'idle');
  const active = phase === 'running' || phase === 'collecting';
  const Icon = active
    ? LoaderCircle
    : phase === 'passed'
      ? CheckCircle2
      : ['failed', 'error', 'unavailable'].includes(phase)
        ? CircleAlert
        : ListChecks;
  const color =
    phase === 'passed'
      ? 'text-emerald-700 dark:text-emerald-300'
      : ['failed', 'error', 'unavailable'].includes(phase)
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-muted-foreground';
  const checks = !view.evaluation ? result?.publicDiagnostics?.caseResults : undefined;
  const title = t(`pblV3.testResult.${phase}`);
  const count = checks?.length
    ? t('pblV3.testResult.count', {
        passed: checks.filter((c) => c.passed).length,
        total: checks.length,
      })
    : '';
  if (mode === 'summary')
    return (
      <span
        role="status"
        data-testid="pbl-test-summary"
        data-state={phase}
        className={`inline-flex items-center gap-1.5 ${color}`}
      >
        <Icon
          size={13}
          className={active ? 'animate-spin shrink-0' : 'shrink-0'}
          aria-hidden="true"
        />
        {title}
        {count && ` · ${count}`}
      </span>
    );
  return (
    <section
      className="space-y-3 rounded-lg border border-l-2 bg-background/30 p-3"
      data-testid="pbl-test-details"
      data-state={phase}
      aria-busy={active}
    >
      <h5 className={`flex items-center gap-2 font-semibold ${color}`}>
        <Icon size={16} className={active ? 'animate-spin' : ''} aria-hidden="true" />
        {title}
        {count && <span className="font-normal">{count}</span>}
      </h5>
      {checks?.length ? (
        <ul className="space-y-2">
          {checks.map((check) => (
            <li key={check.id} className="flex items-start gap-2 text-xs">
              {check.passed ? (
                <CheckCircle2 size={14} className="shrink-0 text-emerald-500" aria-hidden="true" />
              ) : (
                <XCircle size={14} className="shrink-0 text-amber-500" aria-hidden="true" />
              )}
              <span className="min-w-0 break-words">
                {check.label}:{' '}
                {t(
                  check.passed
                    ? 'pblV3.testResult.casePassed'
                    : `pblV3.testResult.reasons.${check.reason ?? 'output'}`,
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : !view.evaluation && !result?.publicDiagnostics && result?.publicFeedback ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs">
          {result.publicFeedback}
        </pre>
      ) : null}
      <p className="text-xs text-muted-foreground">{t(`pblV3.testResult.hints.${phase}`)}</p>
    </section>
  );
}
