'use client';
import { cn } from '@/lib/utils';
import type { FileReference } from '@/lib/pbl/v3/file-reference';
import { environmentNotice, environmentNoticeKeys } from '@/lib/pbl/v3/environment-status';
import { ApplicationPreview, ApplicationPreviewToggle } from './application-preview';
import { useApplicationPreview } from './use-application-preview';
import { usePblActivityGeneration } from './activity-provider';
import {
  ArrowRight,
  ArrowLeft,
  MessageSquareText,
  RefreshCw,
  RotateCcw,
  ChevronDown,
  Moon,
  Sun,
  PanelLeft,
  PanelRight,
  LoaderCircle,
  BookOpen,
  Minus,
  PencilLine,
  Minimize2,
} from 'lucide-react';
import { useLearningStream } from './use-learning-stream';
import { DecisionResponseForm } from './decision-response';
import { useLearningObservation } from './use-learning-observation';
import { useLearnerMessage } from './use-learner-message';
import { useTheme } from '@/lib/hooks/use-theme';
import { acknowledgeDecisionDraft, hasEditorDraft, useStudyDraft } from './use-project-drafts';
import { WorkbenchSplit } from './workbench-split';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  useMemo,
} from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { ProjectHeroDetails } from '@/lib/pbl/project-hero';
import { LearningWorkbenchPanel } from './workbench-panel';
import type { FileSaveReceipt } from './use-project-editor';
import { ProjectReport } from './project-report';
import { ProjectCompletionDialog } from './project-completion-dialog';
import { useProjectCompletion } from './use-project-completion';
import { reportHandoffTarget } from './report-handoff-target';
import { FileText, CheckCircle2 } from 'lucide-react';
import { LearningPanels } from './learning-panels';
import { LearningConversation } from './conversation';
import { WorkspaceFrame } from './workspace-frame';
import { TestEvaluation } from './test-evaluation';
import { TeachingRunNotice } from './teaching-run-notice';
import { PendingAction } from './pending-action';
import { TaskDock } from './task-dock';
import { DismissibleDetails } from './dismissible-details';
import { ProjectOverview } from './project-overview';
import { ProductionContext } from './production-context';
import { useWorkbenchOnboarding } from './use-workbench-onboarding';
import { WorkbenchOnboarding } from './workbench-onboarding';
import { WorkspaceTour } from '@/components/workbench/workspace/WorkspaceTour';
import { projectTourSteps } from './tour-steps';
import { WorkbenchLoading } from './workbench-loading';
import { pblRequest } from './request';
import { continueActionLabel, needsInitialStart } from '@/lib/pbl/v3/presentation';
export { pblRequest } from './request';
import { SandboxRequestError } from '@/components/sandbox/client';
import { CompanionLayer, type AssistantMode } from './companion-layer';
import { LearnerComposer } from './learner-composer';
import { QuizForm } from './quiz-form';
import {
  toldConversation,
  type NarrationProgress,
  type NarrationTarget,
} from '@/lib/pbl/v3/narration';
import { ROLE_PERSONAS } from '@/lib/pbl/v3/personas';
import { AvatarDisplay } from '@/components/ui/avatar-display';

interface WorkspaceProps {
  sceneId: string;
  projectHero?: ProjectHeroDetails;
  /** The project is taught by companions: the workbench holds its loading from the first frame. */
  companions?: boolean;
  onReturnToHero?: () => void;
  autoOnboarding?: boolean;
  initialEntry?: boolean;
  layoutReady?: boolean;
  onOnboardingChange?: (open: boolean) => void;
  toolbarControl?: ReactNode;
}

function PBLV3WorkspaceContent({
  sceneId,
  projectHero,
  companions = false,
  onReturnToHero,
  autoOnboarding = false,
  initialEntry = false,
  layoutReady = true,
  onOnboardingChange,
  toolbarControl,
}: WorkspaceProps) {
  const activityGeneration = usePblActivityGeneration(sceneId);
  const { resolvedTheme, setTheme } = useTheme();
  const { t, locale } = useI18n(),
    stageId = useStageStore((state) => state.stage?.id);
  const { view, workbench, latestView, updateView, receive, openView } = useLearningObservation();
  const [reportEntry, setReportEntry] = useState<'workspace' | 'completion' | null>(null);
  const reportOpen = reportEntry !== null;
  const [historyOpen, setHistoryOpen] = useState(false);
  const workspaceRoot = useRef<HTMLElement>(null);
  const assistant = useRef<HTMLElement>(null);
  const restoreStartFocus = useRef(false);
  const startButtonRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button || !restoreStartFocus.current) return;
    restoreStartFocus.current = false;
    if (document.activeElement === assistant.current) button.focus({ preventScroll: true });
  }, []);
  const [fileTarget, setFileTarget] = useState<
    (FileReference & { studyId: string; requestId: number }) | null
  >(null);
  const fileTargetSequence = useRef(0);
  // Lines the role points at while speaking; the whiteboard steps aside so they can be seen.
  const [pointer, setPointer] = useState<NarrationTarget | null>(null);
  const taskDock = useRef<{ open: () => void }>(null);
  const [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const storageError = useCallback(() => setError(t('pblV3.draftStorageUnavailable')), [t]);
  const {
    text,
    setText,
    pendingMessage: savedMessage,
    quizAnswers,
    setQuizAnswers,
    decisionDrafts,
    setDecisionDrafts,
    showWorkspace,
    setShowWorkspace,
    showAssistant,
    setShowAssistant,
    restored: draftsRestored,
  } = useStudyDraft(view?.id, storageError);
  const {
    entry: pendingMessage,
    begin: beginMessage,
    finish: finishMessage,
    observe: observeMessage,
  } = useLearnerMessage(view, storageError, savedMessage);
  const [speechActive, setSpeechActive] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  // Explanation-board mode: the code keeps the whole work area; the board floats over it
  // like the classroom whiteboard, and the role lives at the corner as a companion whose
  // conversation opens as a window or docks into the side panel.
  // The whiteboard is out of view until the role calls for it, and away again when the role
  // or the learner puts it away. The toolbar pen is the learner's switch: off, it stays away.
  const [boardOff, setBoardOff] = useState(false);
  const [boardShown, setBoardShown] = useState(false);
  const boardOpen = !boardOff && boardShown;
  // Each stage begins with the board put away: it comes out when the role writes on it,
  // not as an empty window left over from the stage before.
  const boardStage = view
    ? `${view.id}:${view.state.position.milestoneId}:${view.state.position.stageIndex}`
    : '';
  const [boardFor, setBoardFor] = useState(boardStage);
  if (boardFor !== boardStage) {
    setBoardFor(boardStage);
    setBoardShown(false);
  }
  const [assistantMode, setAssistantMode] = useState<AssistantMode>('closed');
  const [pendingDecision, setPendingDecision] = useState<{ id: string; chosen: string } | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const commandInFlight = useRef(false);
  const [sent, setSent] = useState(0);
  const [dirtyFiles, setDirtyFiles] = useState(false);
  const applicationPreview = useApplicationPreview(
    view,
    workbench,
    dirtyFiles,
    true,
    // With a whiteboard the learner starts from the running application, so it launches
    // while the role waits to be started; otherwise it waits for the opening to be delivered.
    pending ||
      (!!view?.needsOpening && !(view.explainBoard && needsInitialStart(view) && !pending)),
  );
  const answerKey = `${view?.id}:${view?.state.position.milestoneId}:${view?.state.position.stageIndex}`;
  const recordedAnswers =
    view?.state.collected[view.state.position.milestoneId ?? '']?.quiz?.answers;
  const answers = quizAnswers.key === answerKey ? quizAnswers.values : (recordedAnswers ?? []);
  const retry = useRef<{
    type: string;
    payload: Record<string, unknown>;
    id: string;
    revision: number;
    uiLocale: string;
    milestoneId: string | null;
  } | null>(null);
  const studyId = view?.id;
  const completedApplication = view?.state.status === 'completed' && !!view.application;
  const receiveSnapshot = useCallback(
    (snapshot: Parameters<typeof receive>[0]) => {
      observeMessage(snapshot.view);
      receive(snapshot);
    },
    [observeMessage, receive],
  );
  const stream = useLearningStream(studyId, receiveSnapshot);
  const refresh = useCallback(async () => {
    const baseline = latestView.current;
    if (studyId) {
      const refreshed = await pblRequest<LearningView>(
        `/api/pbl/v3?id=${encodeURIComponent(studyId)}`,
      );
      observeMessage(refreshed);
      updateView(refreshed, baseline);
    }
  }, [studyId, updateView, latestView, observeMessage]);
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
      observeMessage(opened);
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
  }, [stageId, sceneId, openView, latestView, observeMessage]);
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
          : {
              type,
              payload,
              id: crypto.randomUUID(),
              revision: view.revision,
              uiLocale: locale,
              milestoneId: view.state.position.milestoneId,
            };
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
              uiLocale: request.uiLocale,
              ...request.payload,
            },
          },
        );
        if (
          request.type === 'decide' &&
          !acknowledgeDecisionDraft(
            view.id,
            `${request.milestoneId}:${request.payload.decisionId}`,
            { chosen: request.payload.chosen, rationale: request.payload.rationale },
          )
        )
          storageError();
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
    [view, updateView, refresh, t, locale, beginMessage, finishMessage, latestView, storageError],
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
  const initialStart = !!view && needsInitialStart(view);
  const waitingToStart = initialStart && pendingAction !== 'begin';
  const paneOpen = assistantMode !== 'closed';
  const showPaneComposer = !waitingToStart && !!view?.actions.includes('chat');
  const tourSteps = useMemo(
    () => projectTourSteps({ paneOpen, waitingToStart, showPaneComposer }),
    [paneOpen, waitingToStart, showPaneComposer],
  );
  // One playhead for both presentations: where the telling has got to in the live reply.
  const [told, setTold] = useState<NarrationProgress | null>(null);
  const toldView = useMemo(
    () =>
      view?.conversation && told
        ? { ...view, conversation: [...toldConversation(view.conversation, told)] }
        : null,
    [view, told],
  );
  // The stage's decisions, answered in the task drawer of the conversation or, with the
  // conversation put away, in a card by the avatar: the same form on the same draft.
  const decisionForms = () =>
    !view
      ? null
      : view.decisions.map((decision) => {
          const draftKey = `${view.state.position.milestoneId}:${decision.id}`;
          const selected = view.state.collected[
            view.state.position.milestoneId ?? ''
          ]?.decisions.find((d) => d.id === decision.id);
          return (
            <DecisionResponseForm
              key={`${view.id}:${draftKey}`}
              decision={decision}
              selected={selected}
              draft={decisionDrafts[draftKey]}
              disabled={disabled}
              pendingChosen={
                pendingDecision?.id === decision.id ? pendingDecision.chosen : undefined
              }
              onDraftChange={(draft) =>
                setDecisionDrafts((previous) => ({ ...previous, [draftKey]: draft }))
              }
              onSubmit={(chosen, rationale) =>
                command('decide', {
                  decisionId: decision.id,
                  chosen,
                  ...(rationale === undefined ? {} : { rationale }),
                })
              }
            />
          );
        });
  const undecided =
    !!view &&
    view.decisions.some(
      (decision) =>
        !view.state.collected[view.state.position.milestoneId ?? '']?.decisions.find(
          (made) => made.id === decision.id,
        ),
    );

  const opening = useRef('');
  useEffect(() => {
    if (
      initialStart ||
      !view?.needsOpening ||
      !view.environment?.ready ||
      view.busy ||
      pending ||
      dirtyFiles
    )
      return;
    const key = `${view.id}:${view.environmentId}:${view.state.position.milestoneId}:${view.state.position.stageIndex}:${view.role}`;
    if (opening.current === key) return;
    opening.current = key;
    void command('begin');
  }, [view, pending, dirtyFiles, command, initialStart]);
  const quiz = view?.state.collected[view.state.position.milestoneId ?? '']?.quiz;
  const quizUnchanged =
    !!recordedAnswers &&
    answers.length === recordedAnswers.length &&
    answers.every((answer, index) => answer === recordedAnswers[index]);
  // The stage's quiz, answered in the task drawer or in a card by the avatar: the same
  // questions on the same answers.
  const quizForm = () =>
    !view ? null : (
      <QuizForm
        questions={view.questions}
        answers={answers}
        quiz={quiz}
        canSubmit={view.actions.includes('quiz')}
        disabled={disabled}
        unchanged={quizUnchanged}
        submitting={pendingAction === 'quiz'}
        onAnswer={(question, option) =>
          setQuizAnswers((previous) => {
            const next = previous.key === answerKey ? [...previous.values] : [...answers];
            next[question] = option;
            return { key: answerKey, values: next };
          })
        }
        onSubmit={() => void command('quiz', { answers })}
      />
    );
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
  const canSend = !disabled && !speechActive && !!text.trim();
  const onboardingBlocked =
    !!error ||
    preparationFailed ||
    !!view?.lifecycleError ||
    reportOpen ||
    !!(view?.roleRun && ['failed', 'missing', 'cancelled'].includes(view.roleRun.status));
  const onboardingAvailable =
    layoutReady &&
    !!view &&
    stream.status !== 'unavailable' &&
    (view.completedFilesAvailable ||
      (view.environment?.ready && workbench?.environmentId === view.environmentId));
  // A current snapshot is required to enter, but ordinary HTTP replies can
  // advance view.revision before SSE delivers its workspace. Keep an already
  // open guide through that metadata gap; only real unavailability interrupts.
  const onboardingReady =
    onboardingAvailable &&
    stream.status === 'connected' &&
    (view?.completedFilesAvailable ||
      (!['open', 'prepare'].includes(pendingAction ?? '') &&
        !!workbench &&
        workbench.revision >= view!.revision));
  // First entry includes the HTTP request AND its matching workspace snapshot.
  // Keep one barrier until the guide can take over before paint. Continue/recovery
  // and passive unavailable views remain usable.
  const [entrySettled, setEntrySettled] = useState(false);
  const [entrySlow, setEntrySlow] = useState(false);
  const entryReady = onboardingReady && draftsRestored;
  const entryLoading =
    initialEntry &&
    !entrySettled &&
    !entryReady &&
    !view?.busy &&
    view?.state.status !== 'completed' &&
    !onboardingBlocked &&
    !['unavailable', 'retrying'].includes(stream.status);
  useEffect(() => {
    if (entryReady || onboardingBlocked || ['unavailable', 'retrying'].includes(stream.status))
      setEntrySettled(true);
  }, [entryReady, onboardingBlocked, stream.status]);
  useEffect(() => {
    if (!entryLoading) return;
    // A slow operation needs an exit, not an apparently usable workspace.
    // Returning to the Hero does not cancel or retry the unconfirmed request.
    const timer = window.setTimeout(() => setEntrySlow(true), 30_000);
    return () => window.clearTimeout(timer);
  }, [entryLoading]);
  const onboarding = useWorkbenchOnboarding({
    root: workspaceRoot,
    studyId: view?.id,
    autoStart:
      autoOnboarding &&
      draftsRestored &&
      view?.state.status !== 'completed' &&
      !view?.recovery?.progressReset &&
      !view?.archiveDiscard &&
      (view?.state.position.milestoneIndex ?? 0) <= 0 &&
      (view?.state.position.stageIndex ?? 0) <= 0,
    completed: view?.onboardingCompleted === true,
    ready: !!onboardingReady,
    available: !!onboardingAvailable,
    blocked: onboardingBlocked,
    hasDraft:
      !!text ||
      !!pendingMessage ||
      dirtyFiles ||
      quizAnswers.values.some((answer) => answer !== null) ||
      Object.values(decisionDrafts).some((draft) => !!draft.chosen || !!draft.rationale),
  });
  // Keep the initial overview/start action and guided panel targets visible in Live.
  const boardMode = !!view?.explainBoard;
  // Before the learner starts there is only the work to look at: the running application,
  // with the role introducing the project from its bubble.
  const openedOnPreview = useRef('');
  const startsOnPreview = boardMode && waitingToStart && draftsRestored && !!view?.application;
  const startKey = view?.id ?? '';
  useEffect(() => {
    // The preview opens itself for a declared application; only the code steps aside.
    if (!startsOnPreview || openedOnPreview.current === startKey) return;
    openedOnPreview.current = startKey;
    setShowWorkspace(false);
  }, [startsOnPreview, startKey, setShowWorkspace]);
  useEffect(() => {
    onOnboardingChange?.(onboarding.active || entryLoading);
    return () => onOnboardingChange?.(false);
  }, [onboarding.active, entryLoading, onOnboardingChange]);
  const startDisabled =
    !onboardingReady ||
    (blockedReason !== null && blockedReason !== 'opening') ||
    onboarding.active ||
    entryLoading;
  const startBlockedReasonKey = !startDisabled
    ? null
    : onboarding.active
      ? 'guide'
      : stream.status !== 'connected'
        ? stream.status
        : blockedReason && blockedReason !== 'opening'
          ? blockedReason
          : 'preparing';
  const startBlockedReason = startBlockedReasonKey
    ? t(`pblV3.overview.startBlocked.${startBlockedReasonKey}`)
    : null;
  const blockedId = `pbl-input-blocked-${sceneId}`;
  const button =
    'rounded-md border px-2 py-1.5 text-xs disabled:opacity-40 hover:bg-muted aria-pressed:bg-primary aria-pressed:text-primary-foreground';
  // The role points at lines of a file or at something in the running application: whichever
  // it is comes into view, and the whiteboard steps aside for it.
  const pointAt = (point: NarrationTarget | null) => {
    if (!view) return;
    if (point && 'selector' in point) {
      if (!view.application) return setPointer(null);
      setPointer(point);
      if (!applicationPreview.open) applicationPreview.toggle();
      return;
    }
    const known = !!point && view.files.includes(point.path);
    setPointer(known ? point : null);
    if (!point || !known) return;
    setFileTarget(null);
    setShowWorkspace(true);
  };
  // What the stage asks of the learner, as the card by the avatar shows it: a decision, the
  // quiz, or the tests and what they found. The task drawer holds the same forms.
  const stageTask = !view ? undefined : undecided ? (
    decisionForms()
  ) : view.questions.length > 0 && view.actions.includes('quiz') ? (
    <div className="grid gap-3" data-testid="pbl-companion-quiz">
      {quizForm()}
    </div>
  ) : testStage &&
    (pendingAction === 'evaluate' ||
      pendingAction === 'collect' ||
      !!view.evaluation ||
      !!view.state.collected[view.state.position.milestoneId ?? '']?.tests) ? (
    <div data-testid="pbl-companion-tests">
      <TestEvaluation
        view={view}
        mode="details"
        collectionFailed={resultUnavailable}
        pendingAction={pendingAction}
        beside
      />
    </div>
  ) : undefined;
  // The project's introduction and its start action: in the assistant pane, or said by the
  // role from its bubble where the workbench teaches with a whiteboard.
  const startAction =
    view && waitingToStart ? (
      // Beside the avatar the reason stays out of sight: a tooltip, and still read aloud.
      <div className="space-y-2" title={boardMode ? (startBlockedReason ?? undefined) : undefined}>
        <button
          ref={startButtonRef}
          data-pbl-tour="start"
          type="button"
          className="flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 font-semibold text-primary-foreground transition-colors enabled:hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={startDisabled}
          aria-describedby={startBlockedReason ? `pbl-start-blocked-${sceneId}` : undefined}
          onClick={() => {
            // Keep focus in the assistant when this button is replaced.
            restoreStartFocus.current = true;
            assistant.current?.focus({ preventScroll: true });
            void command('begin').then((ok) => {
              if (ok) restoreStartFocus.current = false;
            });
          }}
        >
          <ArrowRight size={18} aria-hidden="true" />
          {t('pblV3.overview.startLearning')}
        </button>
        {startBlockedReason && (
          <p
            id={`pbl-start-blocked-${sceneId}`}
            className={boardMode ? 'sr-only' : 'text-xs text-muted-foreground'}
          >
            {startBlockedReason}
          </p>
        )}
      </div>
    ) : undefined;
  const overview = view ? (
    <ProjectOverview key={view.id} view={view} hero={projectHero} startAction={startAction} />
  ) : null;
  const finishOnboarding = () => {
    if (!view) return;
    onboarding.close();
    if (view.onboardingCompleted !== true) {
      void pblRequest(
        '/api/pbl/v3/onboarding',
        { studyId: view.id },
        AbortSignal.timeout(10_000),
      ).catch(() => {
        // Optional UI metadata must not block learning. A later entry can retry.
      });
    }
  };
  // While the application is coming up for the first time in this visit, the workbench waits
  // with it. A launch that takes too long gives the workbench back instead of holding it.
  // Held from the first frame: before the study is known, and then until its application has
  // come up once in this visit. Closing the preview later does not bring the hold back.
  const [launchedStudy, setLaunchedStudy] = useState<string | null>(null);
  if (view && applicationPreview.document && launchedStudy !== view.id) setLaunchedStudy(view.id);
  // Completed studies restore compute only on request. Leave that button and
  // any failed open/prepare retry reachable until the learner starts it.
  const awaitingRestore =
    completedApplication && !view?.environment?.ready && pendingAction !== 'prepare';
  const applicationComing =
    !error &&
    !preparationFailed &&
    !awaitingRestore &&
    (!view
      ? companions
      : boardMode &&
        !!view.application &&
        launchedStudy !== view.id &&
        !applicationPreview.error &&
        !applicationPreview.expired);
  const launchingApplication = useLaunchHold(applicationComing, 90_000);
  const completion = useProjectCompletion(view, {
    reportOpen,
    blocked:
      !!told || pending || historyOpen || onboarding.active || entryLoading || launchingApplication,
  });
  const getReportTarget = useCallback(() => reportHandoffTarget(workspaceRoot.current), []);
  const modalActive = onboarding.active || entryLoading || completion.open;
  return (
    <section
      ref={workspaceRoot}
      tabIndex={-1}
      data-pbl-focus-owner
      // The chrome is a fixed viewport. Programmatic scrollIntoView (including
      // replay-button focus) must scroll inner panes, never this overlay coordinate root.
      className="relative flex h-full min-h-0 flex-col overflow-clip bg-background text-foreground"
      data-testid="pbl-v3-workspace"
      // Editor, terminal and teaching inputs own their keys, not the host's slide/chat shortcuts.
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="pbl-topbar flex shrink-0 items-center gap-2 border-b pbl-chrome py-2 pl-3 pr-3">
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
            <button
              type="button"
              data-pbl-tour="replay"
              className="inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-40"
              aria-label={t('pblV3.onboarding.replay')}
              title={t(onboardingReady ? 'pblV3.onboarding.replay' : 'pblV3.onboarding.waiting')}
              disabled={onboardingBlocked || !onboardingReady}
              onClick={onboarding.replay}
            >
              <BookOpen size={14} />
              <span className="hidden xl:inline">{t('pblV3.onboarding.replay')}</span>
            </button>
            {view.application && <ApplicationPreviewToggle preview={applicationPreview} />}
            <LearningPanels key={view.id} view={view} modalActive={modalActive} />
            {view.reportAvailable && (
              <button
                data-pbl-tour="report"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500"
                onClick={() => setReportEntry('workspace')}
                disabled={view.busy}
                aria-label={t('pblV3.report')}
              >
                <FileText size={14} />
                {t('pblV3.report')}
              </button>
            )}
            <DismissibleDetails className="relative text-xs">
              <summary
                data-pbl-tour="environment"
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
            </DismissibleDetails>
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
        {view?.canReset && (
          <button
            type="button"
            data-testid="pbl-progress-reset"
            className={button}
            disabled={pending || refreshing}
            aria-label={t('pblV3.resetProgress')}
            title={t('pblV3.resetProgress')}
            onClick={() => {
              if (!window.confirm(t('pblV3.resetProgressConfirm'))) return;
              setPending(true);
              // The study leaves this scene on the server; reloading lands on the entrance,
              // where the next start opens a new one.
              void pblRequest('/api/pbl/v3', { action: 'reset', studyId: view.id })
                .then(() => window.location.reload())
                .catch((e) => {
                  setError(e.message);
                  setPending(false);
                });
            }}
          >
            <RotateCcw size={14} />
          </button>
        )}
        {boardMode && (
          <button
            type="button"
            data-testid="pbl-board-toggle"
            className="rounded border p-1.5 aria-pressed:bg-primary aria-pressed:text-primary-foreground"
            data-pbl-tour="layout"
            aria-label={t('whiteboard.title')}
            title={t('whiteboard.title')}
            aria-pressed={boardOpen}
            onClick={() => {
              setBoardOff(boardOpen);
              setBoardShown(!boardOpen);
            }}
          >
            <PencilLine size={14} />
          </button>
        )}
        <button
          data-pbl-tour="layout"
          data-pbl-tour-legacy="workspace-toggle"
          className="rounded border p-1.5 aria-pressed:bg-primary aria-pressed:text-primary-foreground"
          aria-label={t('pblV3.ide.toggleWorkspace')}
          aria-pressed={showWorkspace}
          onClick={() => setShowWorkspace(!showWorkspace)}
        >
          <PanelLeft size={14} />
        </button>
        <button
          className="rounded border p-1.5 aria-pressed:bg-primary aria-pressed:text-primary-foreground"
          data-pbl-tour="layout"
          aria-label={t('pblV3.ide.toggleAssistant')}
          aria-pressed={boardMode ? assistantMode === 'docked' : showAssistant}
          onClick={() => {
            if (boardMode) {
              setAssistantMode(assistantMode === 'docked' ? 'closed' : 'docked');
              return;
            }
            setShowAssistant(!showAssistant);
          }}
        >
          <PanelRight size={14} />
        </button>
        <div className="ms-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="rounded border p-1.5 hover:bg-muted"
            aria-label={t('pblV3.ide.theme')}
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          >
            {resolvedTheme === 'dark' ? <Moon size={14} /> : <Sun size={14} />}
          </button>
          {toolbarControl}
        </div>
      </header>
      {completion.open && view && (
        <ProjectCompletionDialog
          key={`completion-${view.id}`}
          root={workspaceRoot}
          getReportTarget={getReportTarget}
          onDismiss={completion.dismiss}
          onOpenReport={() => {
            completion.dismiss();
            setReportEntry('completion');
          }}
        />
      )}
      {view?.reportAvailable && (
        <ProjectReport
          key={view.id}
          studyId={view.id}
          title={view.title}
          open={reportOpen}
          onClose={() => setReportEntry(null)}
          onWorkbench={() => setReportEntry(null)}
          getReturnFocus={reportEntry === 'completion' ? getReportTarget : undefined}
        />
      )}
      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 p-2 text-xs"
        >
          <p className="flex-1">{error}</p>
          {retry.current && retry.current.type !== 'prepare' && (
            <button
              className={button}
              disabled={pending || (retry.current.type === 'chat' && speechActive)}
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
          {!view.environment?.ready && (!view.completedFilesAvailable || view.application) && (
            <div
              role="status"
              aria-busy={pendingAction === 'prepare'}
              data-testid="pbl-environment-setup"
              className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs"
            >
              {!preparationFailed && pending && (
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
              )}
              <p className="flex-1">
                {t(
                  completedApplication && !preparationFailed
                    ? 'pblV3.application.restoreNotice'
                    : environmentNoticeKeys[
                        environmentNotice(
                          view.environment,
                          pendingAction === 'prepare',
                          preparationFailed,
                        )
                      ],
                )}
              </p>
              {!pending && (
                <button
                  className={button}
                  disabled={pending || view.busy}
                  onClick={() => void prepare(retry.current?.type === 'prepare')}
                >
                  {t(
                    preparationFailed
                      ? 'pblV3.prepare'
                      : completedApplication
                        ? 'pblV3.application.restore'
                        : 'pblV3.recoverWorkspace',
                  )}
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
          {view.reportAvailable && (
            <div
              data-testid="pbl-project-completed"
              className="flex shrink-0 flex-wrap items-center gap-3 border-b border-violet-500/20 bg-violet-500/10 px-4 py-3"
            >
              <CheckCircle2 size={22} className="shrink-0 text-violet-500" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{t('pblV3.reportCopy.completedTitle')}</p>
                <p className="text-xs text-muted-foreground">
                  {t(view.busy ? 'pblV3.reportCopy.finalizing' : 'pblV3.reportCopy.completionHint')}
                </p>
              </div>
            </div>
          )}
          <WorkbenchSplit
            application={
              view.application ? (
                <ApplicationPreview
                  application={view.application}
                  preview={applicationPreview}
                  inputPaused={modalActive}
                  pointer={pointer && 'selector' in pointer ? pointer : null}
                />
              ) : undefined
            }
            showApplication={applicationPreview.open}
            onCollapseApplication={applicationPreview.close}
            onCollapseWorkspace={() => setShowWorkspace(false)}
            onCollapseAssistant={() => {
              if (boardMode) {
                setShowWorkspace(true);
                setAssistantMode('closed');
              } else {
                setShowAssistant(false);
              }
            }}
            showWorkspace={showWorkspace}
            showAssistant={boardMode ? assistantMode !== 'closed' : showAssistant}
            assistantWindow={boardMode && assistantMode === 'window'}
            overlay={
              boardMode && view.explainBoard ? (
                <CompanionLayer
                  view={view}
                  board={view.explainBoard}
                  // The whiteboard steps aside while the role points at code or the application.
                  boardOpen={boardOpen && !pointer}
                  onBoard={setBoardShown}
                  onPoint={pointAt}
                  onTold={setTold}
                  waitingToStart={waitingToStart}
                  startAction={startAction}
                  task={stageTask}
                  onOpenTask={() => {
                    if (assistantMode === 'closed') setAssistantMode('window');
                    // The drawer lives in the conversation; open it once that is mounted.
                    setTimeout(() => taskDock.current?.open(), 0);
                  }}
                  assistantMode={assistantMode}
                  onAssistantMode={setAssistantMode}
                  introducing={onboarding.active}
                  pendingAction={pendingAction}
                  pendingMessage={pendingMessage}
                  pending={pending}
                  disabled={disabled}
                  blockedReason={blockedReason}
                  inputId={`pbl-companion-chat-${sceneId}`}
                  text={text}
                  onTextChange={setText}
                  speechActive={speechActive}
                  onSpeechActiveChange={setSpeechActive}
                  command={command}
                />
              ) : undefined
            }
            workspace={
              <LearningWorkbenchPanel
                key={view.id}
                view={view}
                fileTarget={fileTarget?.studyId === view.id ? fileTarget : null}
                pointer={pointer && 'path' in pointer ? pointer : null}
                onCloseLastFile={boardMode ? () => setShowWorkspace(false) : undefined}
                onFileTargetConsumed={(requestId) =>
                  setFileTarget((current) =>
                    current?.studyId === view.id && current.requestId === requestId
                      ? null
                      : current,
                  )
                }
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
                      [
                        'PROGRESS_CHANGED',
                        'ENVIRONMENT_UNAVAILABLE',
                        'ENVIRONMENT_CHANGED',
                      ].includes(error.reason ?? '')
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
              <>
                <section
                  ref={assistant}
                  tabIndex={-1}
                  aria-label={t('pblV3.learning')}
                  data-testid="pbl-assistant"
                  data-pbl-tour="conversation"
                  className="flex h-full min-h-0 flex-col bg-muted/10 focus-visible:outline-none focus-visible:[&>header]:ring-2 focus-visible:[&>header]:ring-inset focus-visible:[&>header]:ring-ring"
                >
                  <header
                    data-window-drag={assistantMode === 'window' ? '' : undefined}
                    className={cn(
                      'pbl-pane-header pbl-chrome relative z-30 flex shrink-0 items-center gap-2 border-b px-3 text-xs',
                      boardMode &&
                        assistantMode === 'window' &&
                        'cursor-grab active:cursor-grabbing',
                    )}
                  >
                    {boardMode && view.role ? (
                      <>
                        <span
                          className="size-8 shrink-0 overflow-hidden rounded-full bg-muted ring-2"
                          style={
                            { '--tw-ring-color': ROLE_PERSONAS[view.role].color } as CSSProperties
                          }
                        >
                          <AvatarDisplay src={ROLE_PERSONAS[view.role].avatar} alt="" />
                        </span>
                        <h3 className="min-w-0 leading-tight">
                          <span className="block text-sm font-semibold">
                            {t(`pblV3.personas.${view.role}`)}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            {t(`pblV3.roles.${view.role}`)}
                          </span>
                        </h3>
                        <span className="ml-auto" />
                      </>
                    ) : (
                      <>
                        <MessageSquareText size={15} className="shrink-0" />
                        <h3 className="min-w-0 truncate font-semibold">{t('pblV3.learning')}</h3>
                        <span className="ml-auto truncate text-muted-foreground">
                          {view.role ? t(`pblV3.roles.${view.role}`) : t('pblV3.checks')}
                        </span>
                      </>
                    )}
                    {boardMode && (
                      <>
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          data-testid="pbl-assistant-dock"
                          aria-label={t(
                            assistantMode === 'window' ? 'pblV3.board.dock' : 'pblV3.board.float',
                          )}
                          title={t(
                            assistantMode === 'window' ? 'pblV3.board.dock' : 'pblV3.board.float',
                          )}
                          onClick={() =>
                            setAssistantMode(assistantMode === 'window' ? 'docked' : 'window')
                          }
                        >
                          {assistantMode === 'window' ? (
                            <PanelRight size={14} />
                          ) : (
                            <Minimize2 size={14} />
                          )}
                        </button>
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          data-testid="pbl-assistant-close"
                          aria-label={t('pblV3.board.collapse')}
                          title={t('pblV3.board.collapse')}
                          onClick={() => setAssistantMode('closed')}
                        >
                          <Minus size={14} />
                        </button>
                      </>
                    )}
                  </header>
                  <TeachingRunNotice
                    run={view.roleRun}
                    disabled={disabled}
                    retrying={pendingAction === 'retry'}
                    blockedReason={blockedReason}
                    onRetry={() => void command('retry')}
                  />

                  <div className="pbl-task-area flex min-h-0 flex-1 flex-col">
                    <LearningConversation
                      waitingToStart={waitingToStart}
                      overview={overview}
                      modalActive={modalActive}
                      // The conversation shows the reply as far as it has been told, the same
                      // place the bubble is at.
                      view={toldView ?? view}
                      onOpenFile={(reference) => {
                        setShowWorkspace(true);
                        setFileTarget({
                          ...reference,
                          studyId: view.id,
                          requestId: ++fileTargetSequence.current,
                        });
                      }}
                      onOpenReport={
                        view.reportAvailable && !view.busy
                          ? () => setReportEntry('workspace')
                          : undefined
                      }
                      onHistoryOpenChange={setHistoryOpen}
                      onOpenTask={() => taskDock.current?.open()}
                      sent={sent}
                      pendingMessage={pendingMessage}
                      requesting={['chat', 'begin', 'retry'].includes(pendingAction ?? '')}
                    />
                    <TaskDock
                      actionDisabled={disabled}
                      modalActive={modalActive}
                      key={`${view.id}:${view.state.position.milestoneIndex}:${view.state.position.stageIndex}`}
                      view={view}
                      ref={taskDock}
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
                              className="pbl-stage-action flex h-10 w-full min-w-0 items-center justify-center gap-2 rounded-lg border px-3 text-center text-xs font-semibold transition-colors disabled:cursor-not-allowed"
                              data-state={disabled ? 'disabled' : 'ready'}
                              disabled={disabled}
                              aria-busy={pendingAction === 'next'}
                              onClick={() => void command('next')}
                            >
                              {pendingAction === 'next' && (
                                <LoaderCircle size={13} className="shrink-0 animate-spin" />
                              )}
                              <span className="line-clamp-2 min-w-0 break-words leading-4">
                                {continueActionLabel(view, t)}
                              </span>
                              <ArrowRight
                                size={15}
                                className="shrink-0 rtl:-scale-x-100"
                                aria-hidden="true"
                              />
                            </button>
                          )
                        )
                      }
                    >
                      {view.stage.kind === 'produce' && <ProductionContext view={view} />}

                      {(view.actions.includes('compile') ||
                        (view.stage.kind !== 'check' &&
                          view.evaluation?.purpose === 'compile')) && (
                        <div className="space-y-2" data-testid="pbl-build-controls">
                          {view.actions.includes('compile') && (
                            <button
                              className={button}
                              disabled={disabled || !!view.evaluation}
                              aria-busy={pendingAction === 'compile'}
                              onClick={() => void command('compile')}
                            >
                              {pendingAction === 'compile' && (
                                <LoaderCircle
                                  size={13}
                                  className="animate-spin"
                                  aria-hidden="true"
                                />
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
                      {decisionForms()}
                      {quizForm()}
                    </TaskDock>
                  </div>
                  {showPaneComposer && (
                    <form
                      data-pbl-tour="composer"
                      className="shrink-0 border-t bg-background p-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (canSend) void command('chat', { text });
                      }}
                    >
                      {blockedReason &&
                        blockedReason !== 'busy' &&
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
                      {(blockedReason === 'busy' ||
                        blockedReason === 'unsaved' ||
                        blockedReason === 'pending') && (
                        <span id={blockedId} className="sr-only">
                          {t(`pblV3.inputBlocked.${blockedReason}`)}
                        </span>
                      )}
                      <LearnerComposer
                        key={view.id}
                        id={`pbl-chat-${sceneId}`}
                        text={text}
                        onTextChange={setText}
                        onSend={() => void command('chat', { text })}
                        busy={view.busy}
                        onStop={() => void command('cancel')}
                        stopDisabled={pending}
                        sending={pendingAction === 'chat'}
                        disabled={disabled}
                        blockedTitle={
                          blockedReason ? t(`pblV3.inputBlocked.${blockedReason}`) : undefined
                        }
                        describedBy={blockedReason ? blockedId : undefined}
                        voice={boardMode ? assistantMode !== 'closed' : showAssistant}
                        speechActive={speechActive}
                        onSpeechActiveChange={setSpeechActive}
                        classic={!boardMode}
                      />
                    </form>
                  )}
                </section>
              </>
            }
          />
        </>
      )}
      {entryLoading && (
        <WorkbenchLoading
          root={workspaceRoot}
          onReturnToHero={entrySlow ? onReturnToHero : undefined}
        />
      )}
      {launchingApplication && (
        // The work is the first thing to look at: nothing else is offered until it is up.
        <div
          role="status"
          aria-live="polite"
          data-testid="pbl-application-launching"
          className="absolute inset-0 z-[70] grid place-items-center bg-background/75 backdrop-blur-sm"
        >
          <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
            <span className="size-9 animate-spin rounded-full border-[3px] border-primary/25 border-t-primary" />
            {t('pblV3.application.starting')}
          </div>
        </div>
      )}
      {view && onboarding.active && boardMode && (
        <WorkspaceTour
          key={view.id}
          steps={tourSteps}
          copy="pblV3.tour"
          doneLabel={waitingToStart ? 'pblV3.tour.done' : 'pblV3.onboarding.finish'}
          onNavigate={() => {}}
          onSendExample={() => {}}
          onEnd={finishOnboarding}
        />
      )}
      {view && onboarding.active && !boardMode && (
        <WorkbenchOnboarding
          key={view.id}
          view={view}
          root={workspaceRoot}
          returnFocus={onboarding.returnFocus}
          onFinish={finishOnboarding}
        />
      )}
    </section>
  );
}

export function PBLV3Workspace({ sceneId, ...props }: WorkspaceProps) {
  return (
    <WorkspaceFrame sceneId={sceneId}>
      <PBLV3WorkspaceContent sceneId={sceneId} {...props} />
    </WorkspaceFrame>
  );
}

/** True while `active` holds, for at most `limit` ms: a stuck launch never locks the page. */
function useLaunchHold(active: boolean, limit: number) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setExpired(true), limit);
    return () => {
      clearTimeout(timer);
      setExpired(false);
    };
  }, [active, limit]);
  return active && !expired;
}
