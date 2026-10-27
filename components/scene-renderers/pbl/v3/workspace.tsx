'use client';
import { usePblActivityGeneration } from './activity-provider';
import {
  ArrowUp,
  ArrowLeft,
  Square,
  MessageSquareText,
  RefreshCw,
  ChevronDown,
  Moon,
  Sun,
  PanelLeft,
  PanelRight,
  LoaderCircle,
} from 'lucide-react';
import { useLearningStream } from './use-learning-stream';
import { useLearningObservation } from './use-learning-observation';
import { useLearnerMessage } from './use-learner-message';
import { useTheme } from '@/lib/hooks/use-theme';
import { hasEditorDraft, useStudyDraft } from './use-project-drafts';
import { WorkbenchSplit } from './workbench-split';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import type { LearningView } from '@/lib/pbl/v3/types';
import { LearningWorkbenchPanel } from './workbench-panel';
import type { FileSaveReceipt } from './use-project-editor';
import { LearningPanels } from './learning-panels';
import { LearningConversation } from './conversation';
import { WorkspaceFrame } from './workspace-frame';
import { TestEvaluation } from './test-evaluation';
import { PendingAction } from './pending-action';
import { TaskDock } from './task-dock';
import { ProductionContext } from './production-context';
import { sandboxErrorMessage } from '@/lib/sandbox/error-message';
import { SandboxRequestError } from '@/components/sandbox/client';

const headers = { 'content-type': 'application/json', 'x-openmaic-sandbox': '1' };
export async function pblRequest<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers,
    ...(signal ? { signal } : {}),
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new SandboxRequestError(
      sandboxErrorMessage(data.error),
      response.status,
      data.error?.code,
      data.error?.reason,
    );
  return data as T;
}
function PBLV3WorkspaceContent({
  sceneId,
  onReturnToHero,
}: {
  sceneId: string;
  onReturnToHero?: () => void;
}) {
  const activityGeneration = usePblActivityGeneration(sceneId);
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useI18n(),
    stageId = useStageStore((state) => state.stage?.id);
  const { view, workbench, latestView, updateView, receive, openView } = useLearningObservation();
  const [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const storageError = useCallback(() => setError(t('pblV3.draftStorageUnavailable')), [t]);
  const {
    text,
    setText,
    quizAnswers,
    setQuizAnswers,
    showWorkspace,
    setShowWorkspace,
    showAssistant,
    setShowAssistant,
  } = useStudyDraft(view?.id, storageError);
  const {
    entry: pendingMessage,
    begin: beginMessage,
    finish: finishMessage,
  } = useLearnerMessage(view, setText);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<{ id: string; chosen: string } | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const commandInFlight = useRef(false);
  const [sent, setSent] = useState(0);
  const [dirtyFiles, setDirtyFiles] = useState(false);
  const answerKey = `${view?.id}:${view?.state.position.milestoneId}:${view?.state.position.stageIndex}`;
  const answers = quizAnswers.key === answerKey ? quizAnswers.values : [];
  const retry = useRef<{
    type: string;
    payload: Record<string, unknown>;
    id: string;
    revision: number;
  } | null>(null);
  const studyId = view?.id;
  const stream = useLearningStream(studyId, receive);
  const refresh = useCallback(async () => {
    const baseline = latestView.current;
    if (studyId)
      updateView(
        await pblRequest<LearningView>(`/api/pbl/v3?id=${encodeURIComponent(studyId)}`),
        baseline,
      );
  }, [studyId, updateView, latestView]);
  const openAttempt = useRef(0);
  const open = useCallback(async () => {
    if (!stageId) return;
    const attempt = ++openAttempt.current;
    const baseline = latestView.current;
    setPending(true);
    setPendingAction('open');
    setError('');
    try {
      const opened = await pblRequest<LearningView>('/api/pbl/v3', {
        action: 'open',
        stageId,
        sceneId,
      });
      if (attempt !== openAttempt.current) return;
      setDirtyFiles(hasEditorDraft(opened.id));
      openView(opened, baseline);
    } catch (e) {
      if (attempt === openAttempt.current) setError((e as Error).message);
    } finally {
      if (attempt === openAttempt.current) {
        setPending(false);
        setPendingAction(null);
      }
    }
  }, [stageId, sceneId, openView, latestView]);
  useEffect(() => {
    void open();
  }, [open]);
  const command = useCallback(
    async (type: string, payload: Record<string, unknown> = {}, repeat = false) => {
      if (!view || commandInFlight.current) return false;
      commandInFlight.current = true;
      setPending(true);
      setError('');
      const request =
        repeat && retry.current
          ? retry.current
          : { type, payload, id: crypto.randomUUID(), revision: view.revision };
      retry.current = request;
      setPendingAction(request.type);
      if (request.type === 'decide')
        setPendingDecision({
          id: String(request.payload.decisionId),
          chosen: String(request.payload.chosen),
        });
      if (type === 'chat' && !repeat) setSent((n) => n + 1);
      if (request.type === 'chat') beginMessage(view, request.id, String(request.payload.text));
      const baseline = latestView.current;
      try {
        const result = await pblRequest<{ view: LearningView; result?: { stale?: boolean } }>(
          '/api/pbl/v3',
          {
            studyId: view.id,
            command: {
              id: request.id,
              revision: request.revision,
              type: request.type,
              ...request.payload,
            },
          },
        );
        updateView(result.view, baseline);
        if (result.result?.stale) setError(t('pblV3.testResult.stale'));
        retry.current = null;
        if (request.type === 'chat') finishMessage(request.id, true, latestView.current);
        return true;
      } catch (e) {
        if (e instanceof SandboxRequestError && e.status === 409 && e.reason === 'PROGRESS_CHANGED')
          retry.current = null;
        setError((e as Error).message);
        await refresh().catch(() => {});
        if (request.type === 'chat') finishMessage(request.id, false, latestView.current);
        return false;
      } finally {
        commandInFlight.current = false;
        setPendingAction(null);
        setPendingDecision(null);
        setPending(false);
      }
    },
    [view, updateView, refresh, t, beginMessage, finishMessage, latestView],
  );
  const [preparationFailed, setPreparationFailed] = useState(false);
  const preparationAttempt = useRef('');
  const prepare = useCallback(
    async (repeat = false) => {
      if (commandInFlight.current) return;
      setPreparationFailed(false);
      if (!(await command('prepare', {}, repeat))) setPreparationFailed(true);
    },
    [command],
  );
  useEffect(() => {
    if (!view || pending || preparationFailed || view.busy || view.state.status === 'completed')
      return;
    const key = `${view.id}:${activityGeneration}`;
    if (view.environment?.ready) {
      preparationAttempt.current = key;
      return;
    }
    if (preparationAttempt.current === key) return;
    // Only real learner input/entry can retry automatic restoration. SSE updates cannot.
    preparationAttempt.current = key;
    void prepare();
  }, [view, pending, preparationFailed, prepare, activityGeneration]);
  // The event stream observes execution; a separate, idempotent command commits the verdict.
  // Collect terminal test runs automatically, including after refresh. A failed
  // collection offers a manual retry instead of an unbounded request loop.
  const collectionAttempt = useRef('');
  const [collectionFailed, setCollectionFailed] = useState('');
  const testStage = view?.stage.kind === 'check' && view.stage.checker === 'tests';
  const evaluationKey = view?.evaluation ? `${view.id}:${view.evaluation.id}` : '';
  const buildWorking =
    !testStage &&
    (pendingAction === 'compile' ||
      (view?.evaluation?.purpose === 'compile' &&
        (pendingAction === 'collect' ||
          ['starting', 'running', 'unknown'].includes(view.evaluation.state))));
  useEffect(() => {
    if (
      !testStage ||
      !view?.evaluation ||
      pending ||
      view.busy ||
      dirtyFiles ||
      !view.environment?.ready ||
      !['exited', 'cancelled', 'timed_out', 'failed'].includes(view.evaluation.state) ||
      collectionAttempt.current === evaluationKey
    )
      return;
    collectionAttempt.current = evaluationKey;
    void command('collect', { evaluationId: view.evaluation.id }).then((ok) => {
      if (!ok) setCollectionFailed(evaluationKey);
    });
  }, [testStage, view, pending, dirtyFiles, evaluationKey, command]);
  const resultUnavailable =
    testStage &&
    !!view?.evaluation &&
    (collectionFailed === evaluationKey ||
      ['unknown', 'unavailable'].includes(view.evaluation.state));
  const opening = useRef('');
  useEffect(() => {
    if (!view?.needsOpening || !view.environment?.ready || view.busy || pending || dirtyFiles)
      return;
    const key = `${view.id}:${view.environmentId}:${view.state.position.milestoneId}:${view.state.position.stageIndex}:${view.role}`;
    if (opening.current === key) return;
    opening.current = key;
    void command('begin');
  }, [view, pending, dirtyFiles, command]);
  const quiz = view?.state.collected[view.state.position.milestoneId ?? '']?.quiz;
  // All teaching actions share their prerequisites, with an explicit path out
  // of each blocked state. Draft input stays editable during recovery.
  const blockedReason =
    pending || stream.status !== 'connected'
      ? 'pending'
      : view?.busy
        ? 'busy'
        : !view?.environment?.ready
          ? 'environment'
          : dirtyFiles
            ? 'unsaved'
            : view?.needsOpening
              ? 'opening'
              : null;
  const disabled = blockedReason !== null;
  const blockedId = `pbl-input-blocked-${sceneId}`;
  const button =
    'rounded-md border px-2 py-1 text-xs disabled:opacity-40 hover:bg-muted aria-pressed:bg-primary aria-pressed:text-primary-foreground';
  return (
    <section
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
      data-testid="pbl-v3-workspace"
      // Editor, terminal and teaching inputs own their keys, not the host's slide/chat shortcuts.
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="pbl-topbar flex shrink-0 items-center gap-2 border-b pbl-chrome py-2 pl-3 pr-12">
        {onReturnToHero && (
          <button
            type="button"
            onClick={onReturnToHero}
            className={button}
            aria-label={t('pbl.v2.workspace.returnToHero')}
            title={t('pbl.v2.workspace.returnToHero')}
          >
            <ArrowLeft size={14} />
          </button>
        )}
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {view?.title ?? t('pblV3.title')}
        </h2>
        <PendingAction action={pendingAction ?? (refreshing ? 'refresh' : null)} />
        {view && stream.status !== 'connected' && (
          <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
            {stream.status !== 'unavailable' && (
              <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
            )}
            {t(
              stream.status === 'unavailable'
                ? 'pblV3.updatesUnavailable'
                : stream.status === 'retrying'
                  ? 'pblV3.reconnectingUpdates'
                  : 'pblV3.connectingUpdates',
            )}
          </span>
        )}
        {view && (
          <>
            <LearningPanels key={view.id} view={view} />
            <details className="relative text-xs">
              <summary
                aria-label={t('pblV3.ide.environmentDetails')}
                className="flex cursor-pointer list-none items-center gap-2 rounded bg-muted px-2 py-1"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${view.environment?.ready ? 'bg-primary' : 'bg-amber-500'}`}
                />
                <span className="pbl-environment-label">
                  {t(view.environment?.ready ? 'pblV3.ide.connected' : 'pblV3.ide.disconnected')}
                </span>
                <ChevronDown size={12} />
              </summary>
              <div className="absolute right-0 top-8 z-30 w-72 space-y-3 rounded border bg-popover p-3 shadow-lg">
                <p>
                  {t(view.environment?.ready ? 'pblV3.ide.connected' : 'pblV3.environmentNotice')}
                </p>
                {view.recovery && (
                  <p>
                    {t(
                      view.recovery.checkpointRevision
                        ? 'pblV3.restoredCheckpoint'
                        : 'pblV3.restartedWorkspace',
                    )}
                    {view.recovery.progressReset && ` ${t('pblV3.restoredProgress')}`}
                  </p>
                )}
              </div>
            </details>
          </>
        )}
        <button
          className={button}
          disabled={pending || refreshing}
          aria-busy={refreshing}
          aria-label={t('pblV3.refresh')}
          title={t('pblV3.refresh')}
          onClick={() => {
            stream.reconnect();
            setRefreshing(true);
            void (view ? refresh() : open())
              .catch((e) => setError(e.message))
              .finally(() => setRefreshing(false));
          }}
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} />
        </button>
        <button
          className="rounded border p-1.5 aria-pressed:bg-primary aria-pressed:text-primary-foreground"
          aria-label={t('pblV3.ide.toggleWorkspace')}
          aria-pressed={showWorkspace}
          onClick={() => {
            if (showWorkspace) setShowAssistant(true);
            setShowWorkspace(!showWorkspace);
          }}
        >
          <PanelLeft size={14} />
        </button>
        <button
          className="rounded border p-1.5 aria-pressed:bg-primary aria-pressed:text-primary-foreground"
          aria-label={t('pblV3.ide.toggleAssistant')}
          aria-pressed={showAssistant}
          onClick={() => {
            if (showAssistant) setShowWorkspace(true);
            setShowAssistant(!showAssistant);
          }}
        >
          <PanelRight size={14} />
        </button>
        <button
          type="button"
          className="rounded border p-1.5 hover:bg-muted"
          aria-label={t('pblV3.ide.theme')}
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
        >
          {resolvedTheme === 'dark' ? <Moon size={14} /> : <Sun size={14} />}
        </button>
      </header>
      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 p-2 text-xs"
        >
          <p className="flex-1">{error}</p>
          {retry.current && retry.current.type !== 'prepare' && (
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
      {!view && <p className="p-4">{t('pblV3.loading')}</p>}
      {view && (
        <>
          {!view.environment?.ready && (
            <div
              role="status"
              data-testid="pbl-environment-setup"
              className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs"
            >
              {!preparationFailed && pending && (
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
              )}
              <p className="flex-1">
                {t(
                  preparationFailed
                    ? 'pblV3.environmentUnavailable'
                    : pending
                      ? 'pblV3.environmentNotice'
                      : 'pblV3.environmentSleeping',
                )}
              </p>
              {!pending && (
                <button
                  className={button}
                  disabled={pending || view.busy}
                  onClick={() => void prepare(retry.current?.type === 'prepare')}
                >
                  {t(preparationFailed ? 'pblV3.prepare' : 'pblV3.recoverWorkspace')}
                </button>
              )}
            </div>
          )}
          {view.lifecycleError && view.environment?.ready && (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              <p className="flex-1">
                {t('pblV3.checkpointUnavailable')}
                {view.checkpointFailure &&
                  ` ${t(`pblV3.checkpointReasons.${view.checkpointFailure.reason}`)}`}
              </p>
              <button
                className={button}
                disabled={pending || view.busy || !!view.evaluation}
                onClick={() => void command('checkpoint')}
              >
                {t('pblV3.retry')}
              </button>
            </div>
          )}
          {view.archiveDiscard && (
            <p
              role="alert"
              className="border-b px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              {t('pblV3.checkpointSkipped')}{' '}
              {view.archiveDiscard.checkpointAt
                ? t('pblV3.lastDurableCheckpoint', {
                    time: new Date(view.archiveDiscard.checkpointAt).toLocaleString(),
                  })
                : t('pblV3.noDurableCheckpoint')}
            </p>
          )}
          {view.recovery?.progressReset && (
            <p
              role="alert"
              className="border-b px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              {t('pblV3.restoredProgress')}
            </p>
          )}
          <WorkbenchSplit
            showWorkspace={showWorkspace}
            showAssistant={showAssistant}
            workspace={
              <LearningWorkbenchPanel
                key={view.id}
                view={view}
                workbench={workbench}
                pending={pending || stream.status !== 'connected'}
                pendingAction={pendingAction}
                onDirtyChange={setDirtyFiles}
                onRefresh={refresh}
                onSave={async (path, text, hash, request): Promise<FileSaveReceipt> => {
                  // Autosave owns its request/receipt, independently of teaching-command retries.
                  const digest = await crypto.subtle.digest(
                    'SHA-256',
                    new TextEncoder().encode(text),
                  );
                  const selected = latestView.current;
                  if (
                    !selected ||
                    selected.id !== view.id ||
                    selected.environmentId !== view.environmentId
                  )
                    throw new Error(t('pblV3.workbench.staleBuffer'));
                  request.revision ??= selected.revision;
                  let result: { view: LearningView };
                  try {
                    result = await pblRequest('/api/pbl/v3', {
                      studyId: selected.id,
                      command: {
                        id: request.id,
                        revision: request.revision,
                        type: 'save',
                        path,
                        text,
                        expectedHash: hash,
                      },
                    });
                  } catch (error) {
                    if (
                      error instanceof SandboxRequestError &&
                      error.status === 409 &&
                      error.reason === 'PROGRESS_CHANGED'
                    )
                      await refresh().catch(() => {});
                    throw error;
                  }
                  updateView(result.view, selected);
                  return {
                    hash: Array.from(new Uint8Array(digest), (b) =>
                      b.toString(16).padStart(2, '0'),
                    ).join(''),
                  };
                }}
              />
            }
            assistant={
              <section
                aria-label={t('pblV3.learning')}
                data-testid="pbl-assistant"
                className="flex h-full min-h-0 flex-col bg-muted/10"
              >
                <header className="pbl-chrome flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs">
                  <MessageSquareText size={15} />
                  <h3 className="font-semibold">{t('pblV3.learning')}</h3>
                  <span className="ml-auto text-muted-foreground">
                    {view.role ? t(`pblV3.roles.${view.role}`) : t('pblV3.checks')}
                  </span>
                </header>
                {view.roleRun &&
                  ['failed', 'cancelled', 'missing'].includes(view.roleRun.status) && (
                    <div role="alert" className="rounded border p-3">
                      <p>{t(`pblV3.run.${view.roleRun.failure ?? view.roleRun.status}`)}</p>
                      {view.roleRun.canRetry && (
                        <button
                          className={button}
                          disabled={disabled}
                          title={
                            blockedReason ? t(`pblV3.inputBlocked.${blockedReason}`) : undefined
                          }
                          onClick={() => void command('retry')}
                        >
                          {t('pblV3.retryResponse')}
                        </button>
                      )}
                    </div>
                  )}

                <div className="pbl-task-area flex min-h-0 flex-1 flex-col">
                  <LearningConversation
                    view={view}
                    sent={sent}
                    pendingMessage={pendingMessage}
                    requesting={['chat', 'begin', 'retry'].includes(pendingAction ?? '')}
                  />
                  <TaskDock
                    key={`${view.id}:${view.state.position.milestoneIndex}:${view.state.position.stageIndex}`}
                    view={view}
                    working={
                      buildWorking ||
                      (testStage &&
                        (pendingAction === 'evaluate' ||
                          pendingAction === 'collect' ||
                          (!!view.evaluation && !resultUnavailable)))
                    }
                    summary={
                      testStage ? (
                        <TestEvaluation
                          view={view}
                          mode="summary"
                          collectionFailed={resultUnavailable}
                          pendingAction={pendingAction}
                        />
                      ) : buildWorking ? (
                        <PendingAction
                          action={pendingAction === 'collect' ? 'collect' : 'compile'}
                        />
                      ) : undefined
                    }
                    action={
                      testStage && !view.actions.includes('next') ? (
                        <button
                          className="pbl-stage-action inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-semibold"
                          disabled={
                            disabled ||
                            (!!view.evaluation && !resultUnavailable) ||
                            (!view.evaluation && !view.actions.includes('evaluate'))
                          }
                          data-state={
                            disabled ||
                            (!!view.evaluation && !resultUnavailable) ||
                            (!view.evaluation && !view.actions.includes('evaluate'))
                              ? 'pending'
                              : 'ready'
                          }
                          onClick={() => {
                            if (view.evaluation) {
                              collectionAttempt.current = '';
                              setCollectionFailed('');
                              void command('collect', { evaluationId: view.evaluation.id }).then(
                                (ok) => {
                                  if (!ok) setCollectionFailed(evaluationKey);
                                },
                              );
                            } else void command('evaluate');
                          }}
                        >
                          {((view.evaluation && !resultUnavailable) ||
                            pendingAction === 'evaluate' ||
                            pendingAction === 'collect') && (
                            <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
                          )}
                          {t(
                            pendingAction === 'evaluate'
                              ? 'pblV3.testResult.running'
                              : pendingAction === 'collect'
                                ? 'pblV3.testResult.collecting'
                                : resultUnavailable
                                  ? 'pblV3.testResult.retryCollect'
                                  : view.evaluation
                                    ? view.evaluation.purpose === 'compile'
                                      ? 'pblV3.build'
                                      : 'pblV3.testResult.running'
                                    : 'pblV3.runTests',
                          )}
                        </button>
                      ) : (
                        view.actions.includes('next') && (
                          <button
                            className="pbl-stage-action inline-flex h-7 min-w-0 max-w-[220px] shrink-0 items-center justify-center truncate rounded-md border px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed"
                            data-state={disabled ? 'disabled' : 'ready'}
                            disabled={disabled}
                            aria-busy={pendingAction === 'next'}
                            onClick={() => void command('next')}
                          >
                            {pendingAction === 'next' && (
                              <LoaderCircle size={13} className="mr-1 animate-spin" />
                            )}
                            {view.milestones?.[view.state.position.milestoneIndex]?.stages[
                              view.state.position.stageIndex + 1
                            ]
                              ? t('pblV3.journey.enterStep', {
                                  step: t(
                                    `pblV3.journey.steps.${view.milestones[view.state.position.milestoneIndex]!.stages[view.state.position.stageIndex + 1]}`,
                                  ),
                                })
                              : t('pblV3.next')}
                          </button>
                        )
                      )
                    }
                  >
                    {view.stage.kind === 'produce' && <ProductionContext view={view} />}

                    {(view.actions.includes('compile') ||
                      (view.stage.kind !== 'check' && view.evaluation?.purpose === 'compile')) && (
                      <div className="space-y-2" data-testid="pbl-build-controls">
                        {view.actions.includes('compile') && (
                          <button
                            className={button}
                            disabled={disabled || !!view.evaluation}
                            aria-busy={pendingAction === 'compile'}
                            onClick={() => void command('compile')}
                          >
                            {pendingAction === 'compile' && (
                              <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
                            )}
                            {t('pblV3.build')}
                          </button>
                        )}
                        {view.evaluation && view.stage.kind !== 'check' && (
                          <>
                            {(['starting', 'running'].includes(view.evaluation.state) ||
                              pendingAction === 'collect') && (
                              <span
                                role="status"
                                aria-busy="true"
                                data-testid="pbl-build-status"
                                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
                              >
                                <LoaderCircle
                                  size={13}
                                  className="animate-spin"
                                  aria-hidden="true"
                                />
                                {t(
                                  pendingAction === 'collect'
                                    ? 'pblV3.activity.collect'
                                    : 'pblV3.activity.build',
                                )}
                              </span>
                            )}
                            <button
                              className={button}
                              disabled={disabled}
                              onClick={() => void command('collect')}
                            >
                              {t('pblV3.collect')}
                            </button>
                            <pre className="whitespace-pre-wrap text-xs">
                              {view.evaluation.stdout}
                              {view.evaluation.stderr}
                            </pre>
                          </>
                        )}
                      </div>
                    )}

                    {testStage && (
                      <TestEvaluation
                        view={view}
                        mode="details"
                        collectionFailed={resultUnavailable}
                        pendingAction={pendingAction}
                      />
                    )}
                    {view.decisions.map((decision) => (
                      <fieldset key={decision.id}>
                        <legend>{decision.prompt}</legend>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {decision.options.map((option) => (
                            <button
                              key={option.id}
                              className={button}
                              aria-busy={
                                pendingDecision?.id === decision.id &&
                                pendingDecision.chosen === option.id
                              }
                              aria-pressed={
                                pendingDecision?.id === decision.id
                                  ? pendingDecision.chosen === option.id
                                  : view.state.collected[
                                      view.state.position.milestoneId ?? ''
                                    ]?.decisions.some(
                                      (d) => d.id === decision.id && d.chosen === option.id,
                                    )
                              }
                              disabled={disabled}
                              onClick={() =>
                                void command('decide', {
                                  decisionId: decision.id,
                                  chosen: option.id,
                                })
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
                              disabled={pendingAction === 'quiz'}
                              checked={answers[index] === i}
                              onChange={() =>
                                setQuizAnswers((previous) => {
                                  const next =
                                    previous.key === answerKey ? [...previous.values] : [];
                                  next[index] = i;
                                  return { key: answerKey, values: next };
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
                        disabled={
                          disabled ||
                          view.questions.some(
                            (question, index) =>
                              !Number.isInteger(answers[index]) ||
                              answers[index]! < 0 ||
                              answers[index]! >= question.options.length,
                          )
                        }
                        aria-busy={pendingAction === 'quiz'}
                        onClick={() => void command('quiz', { answers })}
                      >
                        {pendingAction === 'quiz' && (
                          <LoaderCircle size={13} className="mr-1 inline animate-spin" />
                        )}
                        {t('pblV3.submitQuiz')}
                      </button>
                    )}
                  </TaskDock>
                </div>
                {view.actions.includes('chat') && (
                  <form
                    className="shrink-0 border-t bg-background p-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!disabled && text.trim()) void command('chat', { text });
                    }}
                  >
                    {blockedReason &&
                      blockedReason !== 'unsaved' &&
                      blockedReason !== 'pending' && (
                        <div
                          id={blockedId}
                          role="status"
                          data-testid="pbl-input-blocked"
                          className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
                        >
                          <p className="min-w-0 flex-1">
                            {t(`pblV3.inputBlocked.${blockedReason}`)}
                          </p>
                          {blockedReason === 'opening' && (
                            <button
                              type="button"
                              className={button}
                              onClick={() => void command('begin')}
                            >
                              {t('pblV3.retryOpening')}
                            </button>
                          )}
                        </div>
                      )}
                    {(blockedReason === 'unsaved' || blockedReason === 'pending') && (
                      <span id={blockedId} className="sr-only">
                        {t(`pblV3.inputBlocked.${blockedReason}`)}
                      </span>
                    )}
                    <label className="sr-only" htmlFor={`pbl-chat-${sceneId}`}>
                      {t('pblV3.message')}
                    </label>
                    <div className="rounded-xl border bg-muted/20 p-2 focus-within:ring-1 focus-within:ring-primary">
                      <textarea
                        id={`pbl-chat-${sceneId}`}
                        className="h-20 w-full resize-none bg-transparent p-1 text-sm outline-none"
                        placeholder={t('pblV3.ide.messagePlaceholder')}
                        value={text}
                        aria-describedby={blockedReason ? blockedId : undefined}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            if (!disabled && text.trim()) void command('chat', { text });
                          }
                        }}
                      />
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-muted-foreground">
                          {t('pblV3.ide.sendHint')}
                        </span>
                        {view.busy ? (
                          <button
                            type="button"
                            className="rounded-full bg-primary p-2 text-primary-foreground"
                            aria-label={t('pblV3.cancel')}
                            disabled={pending}
                            onClick={() => void command('cancel')}
                          >
                            <Square size={15} />
                          </button>
                        ) : (
                          <button
                            className="rounded-full bg-primary p-2 text-primary-foreground disabled:opacity-40"
                            aria-label={t('pblV3.send')}
                            aria-busy={pendingAction === 'chat'}
                            disabled={disabled || !text.trim()}
                            title={
                              blockedReason ? t(`pblV3.inputBlocked.${blockedReason}`) : undefined
                            }
                            aria-describedby={blockedReason ? blockedId : undefined}
                          >
                            {pendingAction === 'chat' ? (
                              <LoaderCircle size={16} className="animate-spin" />
                            ) : (
                              <ArrowUp size={16} />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  </form>
                )}
              </section>
            }
          />
        </>
      )}
    </section>
  );
}

export function PBLV3Workspace({
  sceneId,
  onReturnToHero,
}: {
  sceneId: string;
  onReturnToHero?: () => void;
}) {
  return (
    <WorkspaceFrame sceneId={sceneId}>
      <PBLV3WorkspaceContent sceneId={sceneId} onReturnToHero={onReturnToHero} />
    </WorkspaceFrame>
  );
}
