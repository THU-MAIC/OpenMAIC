'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, Save, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { TeacherAnalysisCopy } from '@/lib/i18n/teacher-analysis';
import {
  teacherAnalysisReportSchema,
  type TeacherAnalysis,
  type TeacherAnalysisReport,
  type TeacherAnalysisSource,
  type UpdateTeacherAnalysis,
} from '@/lib/teacher/analysis';
import { teacherRequest, TeacherRequestError } from './student-ui';
import { analysisCollectionUrl, analysisErrorMessage } from './analysis-ui';

function ReportText({
  report,
  copy,
}: {
  report: TeacherAnalysisReport;
  copy: TeacherAnalysisCopy;
}) {
  return (
    <div className="min-w-0 space-y-3 text-sm leading-6 [overflow-wrap:anywhere]">
      {report.observations.map((item, index) => (
        <p key={index}>
          <span className="font-medium">
            {index + 1}. {copy.categories[item.category]}:{' '}
          </span>
          {item.text}
        </p>
      ))}
      <p className="font-medium">{copy.recommendations}</p>
      {report.recommendations.map((item, index) => (
        <p key={index}>{item.text}</p>
      ))}
      <p className="font-medium">{copy.limitations}</p>
      {report.limitations.map((item, index) => (
        <p key={index}>{item}</p>
      ))}
    </div>
  );
}

function CitationEvidence({
  observation,
  sources,
  copy,
}: {
  observation: TeacherAnalysisReport['observations'][number];
  sources: TeacherAnalysisSource[];
  copy: TeacherAnalysisCopy;
}) {
  return (
    <details className="mt-2 min-w-0 text-xs">
      <summary className="text-muted-foreground cursor-pointer py-1">
        {copy.sourceEvidence} · {observation.citations.length}
      </summary>
      <ul className="mt-2 space-y-3">
        {observation.citations.map((citation, index) => {
          const source = sources.find((item) => item.sourceId === citation.sourceId);
          const block = source?.blocks.find((item) => item.blockId === citation.blockId);
          return (
            <li key={index} className="border-l-2 pl-3">
              <p className="text-muted-foreground break-words leading-5 [overflow-wrap:anywhere]">
                {source?.name ?? copy.source} · {source && copy.roles[source.role]} ·{' '}
                {block?.pageNumber
                  ? `${copy.page} ${block.pageNumber}`
                  : `${copy.block} ${citation.blockId}`}
              </p>
              <blockquote className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">
                {citation.quote}
              </blockquote>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function AnalysisEditor({
  analysis,
  copy,
  readOnly = false,
  onSaved,
}: {
  analysis: TeacherAnalysis;
  copy: TeacherAnalysisCopy;
  readOnly?: boolean;
  onSaved: (analysis: TeacherAnalysis) => void;
}) {
  const [base, setBase] = useState(analysis);
  const [report, setReport] = useState(analysis.report);
  const [comment, setComment] = useState(analysis.teacherComment);
  const [busy, setBusy] = useState<UpdateTeacherAnalysis['action'] | 'refresh' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<TeacherAnalysis | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const lastReceivedVersion = useRef(analysis.updatedAt);
  const active = useRef(true);
  const frozen = readOnly || base.status === 'withdrawn';
  const dirty =
    JSON.stringify(report) !== JSON.stringify(base.report) || comment !== base.teacherComment;
  const detailUrl = `${analysisCollectionUrl(base.profileId)}/${encodeURIComponent(base.analysisId)}`;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);

  // A collection refresh may carry a concurrent edit. Preserve the local draft
  // and require the same explicit comparison as a PATCH conflict.
  useEffect(() => {
    if (lastReceivedVersion.current === analysis.updatedAt) return;
    lastReceivedVersion.current = analysis.updatedAt;
    if (analysis.updatedAt !== base.updatedAt) {
      setLatest(analysis);
      setConflict(true);
      setError(copy.conflict);
    }
  }, [analysis, base.updatedAt, copy.conflict]);

  async function update(action: UpdateTeacherAnalysis['action']) {
    if (busy || frozen || conflict || (action === 'confirm_review' && dirty)) return;
    const values = action === 'withdraw' ? base.report : report;
    if (!teacherAnalysisReportSchema.safeParse(values).success) {
      setError(copy.inputInvalid);
      return;
    }
    setBusy(action);
    setError('');
    setNotice('');
    const requestController = new AbortController();
    controller.current = requestController;
    try {
      const response = await teacherRequest<{ analysis: TeacherAnalysis }>(detailUrl, {
        method: 'PATCH',
        signal: requestController.signal,
        body: JSON.stringify({
          expectedUpdatedAt: base.updatedAt,
          action,
          report: values,
          teacherComment: action === 'withdraw' ? base.teacherComment : comment,
        } satisfies UpdateTeacherAnalysis),
      });
      if (
        response.analysis.profileId !== base.profileId ||
        response.analysis.analysisId !== base.analysisId
      )
        throw new Error('Unexpected analysis');
      if (!active.current || requestController.signal.aborted) return;
      setBase(response.analysis);
      setReport(response.analysis.report);
      setComment(response.analysis.teacherComment);
      setWithdrawOpen(false);
      setNotice(
        action === 'confirm_review'
          ? copy.reviewedNotice
          : action === 'withdraw'
            ? copy.withdrawnNotice
            : copy.saved,
      );
      onSaved(response.analysis);
    } catch (failure) {
      if (!active.current || requestController.signal.aborted) return;
      if (failure instanceof TeacherRequestError && failure.code === 'ANALYSIS_CONFLICT')
        setConflict(true);
      setError(analysisErrorMessage(failure, copy));
      setWithdrawOpen(false);
    } finally {
      if (active.current) setBusy(null);
    }
  }

  async function readLatest() {
    if (busy) return;
    setBusy('refresh');
    const requestController = new AbortController();
    controller.current = requestController;
    try {
      const response = await teacherRequest<{ analysis: TeacherAnalysis }>(detailUrl, {
        signal: requestController.signal,
      });
      if (
        response.analysis.profileId !== base.profileId ||
        response.analysis.analysisId !== base.analysisId
      )
        throw new Error('Unexpected analysis');
      if (active.current && !requestController.signal.aborted) setLatest(response.analysis);
    } catch (failure) {
      if (active.current && !requestController.signal.aborted)
        setError(analysisErrorMessage(failure, copy));
    } finally {
      if (active.current) setBusy(null);
    }
  }

  function resolveConflict(keepDraft: boolean) {
    if (!latest || busy) return;
    setBase(latest);
    if (!keepDraft) {
      setReport(latest.report);
      setComment(latest.teacherComment);
    }
    setLatest(null);
    setConflict(false);
    setError('');
    onSaved(latest);
  }

  function changeObservation(index: number, value: string) {
    setReport((current) => ({
      ...current,
      observations: current.observations.map((item, itemIndex) =>
        itemIndex === index ? { ...item, text: value } : item,
      ),
    }));
  }

  return (
    <article
      className="min-w-0 border-t pt-5"
      aria-label={copy.detail}
      data-testid="teacher-analysis-detail"
    >
      <div className="mb-5 min-w-0 space-y-2">
        <h4 className="break-words text-base font-semibold [overflow-wrap:anywhere]">
          {base.request.title}
        </h4>
        <p className="text-muted-foreground text-xs">
          {base.request.workDate} · {base.request.subject} · {copy.workKinds[base.request.workKind]}
        </p>
        <p
          className={
            base.status === 'draft'
              ? 'text-xs text-amber-700 dark:text-amber-400'
              : 'text-muted-foreground text-xs'
          }
          data-testid="teacher-analysis-status"
        >
          {copy[base.status]}
        </p>
        <p className="text-muted-foreground text-xs">{copy[report.readiness]}</p>
      </div>
      <fieldset disabled={Boolean(busy) || frozen} className="min-w-0 space-y-6">
        <section className="min-w-0 space-y-5" aria-label={copy.observations}>
          {report.observations.length ? (
            report.observations.map((observation, index) => (
              <div key={index} className="min-w-0">
                <Label htmlFor={`analysis-observation-${index}`} className="mb-2 leading-5">
                  {index + 1}. {copy.categories[observation.category]}
                </Label>
                {frozen ? (
                  <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
                    {observation.text}
                  </p>
                ) : (
                  <Textarea
                    id={`analysis-observation-${index}`}
                    data-testid={`analysis-observation-${index}`}
                    rows={3}
                    maxLength={800}
                    value={observation.text}
                    onChange={(event) => changeObservation(index, event.target.value)}
                  />
                )}
                <CitationEvidence observation={observation} sources={base.sources} copy={copy} />
              </div>
            ))
          ) : (
            <p className="text-muted-foreground text-sm">{copy.noObservations}</p>
          )}
        </section>
        <section className="min-w-0 space-y-3 border-t pt-5" aria-label={copy.recommendations}>
          <h5 className="text-sm font-semibold">{copy.recommendations}</h5>
          {report.recommendations.length ? (
            report.recommendations.map((item, index) => (
              <div key={index} className="min-w-0">
                {frozen ? (
                  <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
                    {item.text}
                  </p>
                ) : (
                  <Textarea
                    aria-label={`${copy.recommendations} ${index + 1}`}
                    data-testid={`analysis-recommendation-${index}`}
                    rows={2}
                    maxLength={600}
                    value={item.text}
                    onChange={(event) =>
                      setReport((current) => ({
                        ...current,
                        recommendations: current.recommendations.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, text: event.target.value } : entry,
                        ),
                      }))
                    }
                  />
                )}
                {item.observationIndexes.length > 0 && (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {copy.linkedObservations}:{' '}
                    {item.observationIndexes.map((value) => value + 1).join(', ')}
                  </p>
                )}
              </div>
            ))
          ) : (
            <p className="text-muted-foreground text-sm">{copy.noRecommendations}</p>
          )}
        </section>
        <section className="min-w-0 space-y-3 border-t pt-5" aria-label={copy.limitations}>
          <h5 className="text-sm font-semibold">{copy.limitations}</h5>
          {report.limitations.map((item, index) =>
            frozen ? (
              <p
                key={index}
                className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]"
              >
                {item}
              </p>
            ) : (
              <Textarea
                key={index}
                aria-label={`${copy.limitations} ${index + 1}`}
                data-testid={`analysis-limitation-${index}`}
                rows={2}
                maxLength={400}
                value={item}
                onChange={(event) =>
                  setReport((current) => ({
                    ...current,
                    limitations: current.limitations.map((entry, entryIndex) =>
                      entryIndex === index ? event.target.value : entry,
                    ),
                  }))
                }
              />
            ),
          )}
        </section>
        <div className="min-w-0 space-y-3 border-t pt-5">
          <Label htmlFor="teacher-analysis-comment">{copy.teacherComment}</Label>
          {frozen ? (
            <p className="whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
              {comment || '—'}
            </p>
          ) : (
            <Textarea
              id="teacher-analysis-comment"
              maxLength={3000}
              rows={3}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          )}
        </div>
      </fieldset>
      <div className="mt-5 space-y-4 border-t py-5">
        {base.request.teacherNotes && (
          <details>
            <summary className="text-muted-foreground cursor-pointer text-xs">
              {copy.teacherNotes}
            </summary>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
              {base.request.teacherNotes}
            </p>
          </details>
        )}
        <details className="min-w-0">
          <summary className="text-muted-foreground cursor-pointer text-xs">
            {copy.sourceText}
          </summary>
          <ul className="mt-3 min-w-0 space-y-5">
            {base.sources.map((source) => (
              <li key={source.sourceId} className="min-w-0">
                <h5 className="break-words text-sm font-medium [overflow-wrap:anywhere]">
                  {source.name} · {copy.roles[source.role]}
                </h5>
                {source.ocr && (
                  <p className="my-2 text-xs text-amber-700 dark:text-amber-400">{copy.ocr}</p>
                )}
                <div className="mt-2 max-h-64 min-w-0 overflow-y-auto border-l-2 pl-3">
                  {source.blocks.map((block) => (
                    <div key={block.blockId} className="min-w-0 py-2">
                      <p className="text-muted-foreground text-xs">
                        {block.pageNumber ? `${copy.page} ${block.pageNumber} · ` : ''}
                        {copy.block} {block.blockId}
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
                        {block.text}
                      </p>
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </details>
        <details className="min-w-0">
          <summary className="text-muted-foreground cursor-pointer text-xs">
            {copy.originalReport}
          </summary>
          <div className="mt-3">
            <ReportText report={base.originalReport} copy={copy} />
          </div>
        </details>
      </div>
      {error && (
        <p role="alert" className="text-destructive my-3 text-sm leading-6">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-muted-foreground my-3 text-sm leading-6">
          {notice}
        </p>
      )}
      {conflict && (
        <div className="min-w-0 space-y-4 border-y py-4">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => void readLatest()}
          >
            <RefreshCw className={busy === 'refresh' ? 'animate-spin' : ''} />
            {copy.readLatest}
          </Button>
          {latest && (
            <div className="min-w-0 space-y-3">
              <h5 className="text-sm font-semibold">
                {copy.latestVersion} · {copy[latest.status]}
              </h5>
              <ReportText report={latest.report} copy={copy} />
              <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
                {latest.teacherComment}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => resolveConflict(false)}
                >
                  {copy.useLatest}
                </Button>
                {latest.status !== 'withdrawn' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => resolveConflict(true)}
                  >
                    {copy.resolveWithDraft}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {!frozen && (
        <div className="space-y-3 border-t pt-4">
          <p className="text-muted-foreground text-xs leading-5">{copy.reviewBoundary}</p>
          {dirty && <p className="text-muted-foreground text-xs">{copy.reviewFirst}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={Boolean(busy) || conflict || !dirty}
              onClick={() => void update('save_draft')}
            >
              {busy === 'save_draft' ? <LoaderCircle className="animate-spin" /> : <Save />}
              {copy.save}
            </Button>
            <Button
              type="button"
              disabled={Boolean(busy) || conflict || dirty || base.status === 'reviewed'}
              onClick={() => void update('confirm_review')}
            >
              {busy === 'confirm_review' ? <LoaderCircle className="animate-spin" /> : <Check />}
              {copy.confirm}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={Boolean(busy) || conflict}
              onClick={() => setWithdrawOpen(true)}
            >
              <Undo2 />
              {copy.withdraw}
            </Button>
          </div>
        </div>
      )}
      {withdrawOpen && (
        <Dialog open onOpenChange={(open) => !open && !busy && setWithdrawOpen(false)}>
          <DialogContent className="w-[calc(100%-2rem)] max-w-md rounded-lg">
            <DialogHeader className="pr-6">
              <DialogTitle>{copy.withdrawTitle}</DialogTitle>
              <DialogDescription>{copy.withdrawDescription}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => setWithdrawOpen(false)}
              >
                {copy.cancelAction}
              </Button>
              <Button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void update('withdraw')}
              >
                {busy ? <LoaderCircle className="animate-spin" /> : <Undo2 />}
                {copy.withdraw}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </article>
  );
}
