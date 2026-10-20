'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import type { LearningView } from '@/lib/pbl/v3/types';
import { LearningWorkbenchPanel } from './workbench-panel';
import { MarkdownText } from '../v2/markdown-text';
import { sandboxErrorMessage } from '@/lib/sandbox/error-message';
import { SandboxRequestError } from '@/components/sandbox/client';

const headers = { 'content-type': 'application/json', 'x-openmaic-sandbox': '1' };
export async function pblRequest<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    headers,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new SandboxRequestError(
      sandboxErrorMessage(data.error),
      response.status,
      data.error?.code,
    );
  return data as T;
}
export function PBLV3Workspace({ sceneId }: { sceneId: string }) {
  const { t } = useI18n(),
    stageId = useStageStore((state) => state.stage?.id);
  const [view, setView] = useState<LearningView | null>(null),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const [text, setText] = useState('');
  const [answers, setAnswers] = useState<number[]>([]);
  const retry = useRef<{
    type: string;
    payload: Record<string, unknown>;
    id: string;
    revision: number;
  } | null>(null);
  const updateView = useCallback((next: LearningView) => {
    // A delayed poll or command response cannot undo newer progress or replace another study.
    setView((current) =>
      current?.id === next.id && current.revision <= next.revision ? next : current,
    );
  }, []);
  const studyId = view?.id;
  const refresh = useCallback(async () => {
    if (studyId)
      updateView(await pblRequest<LearningView>(`/api/pbl/v3?id=${encodeURIComponent(studyId)}`));
  }, [studyId, updateView]);
  const open = useCallback(async () => {
    if (!stageId) return;
    setPending(true);
    setError('');
    try {
      setView(await pblRequest<LearningView>('/api/pbl/v3', { action: 'open', stageId, sceneId }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }, [stageId, sceneId]);
  useEffect(() => {
    void open();
  }, [open]);
  useEffect(() => {
    if (!view?.busy && !view?.evaluation) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch((e) => setError(e.message));
    }, 2000);
    return () => clearInterval(timer);
  }, [view?.busy, view?.evaluation, refresh]);
  useEffect(() => {
    if (!view?.environmentId || view.state.status === 'completed') return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch((e) => setError(e.message));
    }, 15_000);
    return () => clearInterval(timer);
  }, [view?.environmentId, view?.state.status, refresh]);
  const command = async (type: string, payload: Record<string, unknown> = {}, repeat = false) => {
    if (!view) return false;
    setPending(true);
    setError('');
    const request =
      repeat && retry.current
        ? retry.current
        : { type, payload, id: crypto.randomUUID(), revision: view.revision };
    retry.current = request;
    try {
      const result = await pblRequest<{ view: LearningView }>('/api/pbl/v3', {
        studyId: view.id,
        command: {
          id: request.id,
          revision: request.revision,
          type: request.type,
          ...request.payload,
        },
      });
      updateView(result.view);
      retry.current = null;
      if (request.type === 'chat') setText('');
      return true;
    } catch (e) {
      setError((e as Error).message);
      await refresh().catch(() => {});
      return false;
    } finally {
      setPending(false);
    }
  };
  const quiz = view?.state.collected[view.state.position.milestoneId ?? '']?.quiz;
  const disabled = pending || view?.busy || !view?.environment?.ready;
  const button = 'rounded-md border px-3 py-2 text-sm disabled:opacity-40 hover:bg-muted';
  return (
    <section
      className="h-full overflow-auto bg-background p-4 text-foreground"
      data-testid="pbl-v3-workspace"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{view?.title ?? t('pblV3.title')}</h2>
          {view && (
            <p className="text-sm text-muted-foreground">
              {view.state.position.milestoneId} ·{' '}
              {view.role ? t(`pblV3.roles.${view.role}`) : t('pblV3.checks')}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            className={button}
            disabled={pending}
            onClick={() => void (view ? refresh() : open()).catch((e) => setError(e.message))}
          >
            {t('pblV3.refresh')}
          </button>
          {view?.busy && (
            <button className={button} onClick={() => void command('cancel')}>
              {t('pblV3.cancel')}
            </button>
          )}
        </div>
      </header>
      {error && (
        <div role="alert" className="mb-4 rounded border border-destructive p-3">
          <p>{error}</p>
          {retry.current && (
            <button
              className={button}
              disabled={pending}
              onClick={() => void command('', {}, true)}
            >
              {t('pblV3.retry')}
            </button>
          )}
        </div>
      )}
      {!view && <p>{t('pblV3.loading')}</p>}
      {view && (
        <>
          {!view.environment?.ready && (
            <div className="mb-4 rounded-lg border p-4">
              <p className="mb-3">
                {t(view.environmentId ? 'pblV3.environmentUnavailable' : 'pblV3.environmentNotice')}
              </p>
              <button
                className={button}
                disabled={pending || view.busy}
                onClick={() => void command('prepare')}
              >
                {t('pblV3.prepare')}
              </button>
            </div>
          )}
          {view.recovery && (
            <p role="status" className="mb-4 rounded border p-3">
              {t(
                view.recovery.checkpointRevision
                  ? 'pblV3.restoredCheckpoint'
                  : 'pblV3.restartedWorkspace',
              )}
              {view.recovery.progressReset && ` ${t('pblV3.restoredProgress')}`}
            </p>
          )}
          {view.state.status === 'completed' ? (
            <p role="status">{t('pblV3.completed')}</p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3 rounded-lg border p-4">
                <h3 className="font-semibold">{t('pblV3.learning')}</h3>
                {view.roleRun &&
                  ['failed', 'cancelled', 'missing'].includes(view.roleRun.status) && (
                    <div role="alert" className="rounded border p-3">
                      <p>{t(`pblV3.run.${view.roleRun.failure ?? view.roleRun.status}`)}</p>
                      {view.roleRun.canRetry && (
                        <button
                          className={button}
                          disabled={disabled}
                          onClick={() => void command('retry')}
                        >
                          {t('pblV3.retryResponse')}
                        </button>
                      )}
                    </div>
                  )}
                <div className="max-h-96 space-y-3 overflow-auto" aria-live="polite">
                  {view.messages.map((message, index) => (
                    <article
                      key={index}
                      className={message.role === 'user' ? 'rounded-md bg-muted p-3' : 'p-2'}
                    >
                      <MarkdownText content={message.text} />
                    </article>
                  ))}
                  {view.busy && <p role="status">{t('pblV3.thinking')}</p>}
                </div>
                {view.actions.includes('chat') && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void command('chat', { text });
                    }}
                  >
                    <label className="block text-sm" htmlFor={`pbl-chat-${sceneId}`}>
                      {t('pblV3.message')}
                    </label>
                    <textarea
                      id={`pbl-chat-${sceneId}`}
                      className="my-2 min-h-20 w-full rounded border p-2"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                    <button
                      className={button}
                      disabled={disabled || !view.environmentId || !text.trim()}
                    >
                      {t('pblV3.send')}
                    </button>
                  </form>
                )}
                {view.decisions.map((decision) => (
                  <fieldset key={decision.id}>
                    <legend>{decision.prompt}</legend>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {decision.options.map((option) => (
                        <button
                          key={option.id}
                          className={button}
                          disabled={disabled}
                          onClick={() =>
                            void command('decide', { decisionId: decision.id, chosen: option.id })
                          }
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                ))}
                {view.questions.map((question, index) => (
                  <fieldset key={index}>
                    <legend>{question.q}</legend>
                    {question.options.map((option, i) => (
                      <label className="block" key={i}>
                        <input
                          type="radio"
                          name={`quiz-${index}`}
                          checked={answers[index] === i}
                          onChange={() =>
                            setAnswers((previous) => {
                              const next = [...previous];
                              next[index] = i;
                              return next;
                            })
                          }
                        />{' '}
                        {option}
                      </label>
                    ))}
                  </fieldset>
                ))}
                {view.questions.length > 0 && quiz && (
                  <p role="status">
                    {t(quiz.passed ? 'pblV3.quizPassed' : 'pblV3.quizRetry', {
                      score: quiz.score,
                      total: quiz.total,
                    })}
                  </p>
                )}
                {view.actions.includes('quiz') && (
                  <button
                    className={button}
                    disabled={disabled || answers.length !== view.questions.length}
                    onClick={() => void command('quiz', { answers })}
                  >
                    {t('pblV3.submitQuiz')}
                  </button>
                )}
                {view.actions.includes('next') && (
                  <button
                    className={button}
                    disabled={disabled}
                    onClick={() => void command('next')}
                  >
                    {t('pblV3.next')}
                  </button>
                )}
              </div>
              <LearningWorkbenchPanel
                key={view.id}
                view={view}
                pending={pending}
                onRefresh={refresh}
                onSave={(path, text, expectedHash) => command('save', { path, text, expectedHash })}
                onCheckpoint={() => command('checkpoint')}
              >
                <div className="flex flex-wrap gap-2">
                  {view.actions.includes('evaluate') && (
                    <button
                      className={button}
                      disabled={disabled || !!view.evaluation}
                      onClick={() => void command('evaluate')}
                    >
                      {t('pblV3.runTests')}
                    </button>
                  )}
                  {view.evaluation && (
                    <button
                      className={button}
                      disabled={disabled}
                      onClick={() => void command('collect')}
                    >
                      {t('pblV3.collect')}
                    </button>
                  )}
                </div>
                {view.evaluation && (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-sm">
                    {view.evaluation.state}
                    {'\n'}
                    {view.evaluation.stdout}
                    {'\n'}
                    {view.evaluation.stderr}
                  </pre>
                )}
                {view.state.collected[view.state.position.milestoneId ?? '']?.tests && (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-sm">
                    {view.state.collected[view.state.position.milestoneId!]!.tests!.status}
                    {'\n'}
                    {view.state.collected[view.state.position.milestoneId!]!.tests!.publicFeedback}
                  </pre>
                )}
              </LearningWorkbenchPanel>
            </div>
          )}
        </>
      )}
    </section>
  );
}
