'use client';

/**
 * The generation preview: a view of the server-side run that generates the
 * course (RFC #1754 §E). The page renders the run's events (steps, the
 * outline as it streams, the outline review, the agent cards) and sends the
 * run its commands (confirm the outline, retry a failed step); the run itself
 * goes on whether or not this page is open. Once the course's first scene is
 * ready, the classroom takes over.
 */
import { useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, AlertCircle, AlertTriangle, ArrowLeft, Bot, RefreshCw } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { OutlinesEditor } from '@/components/generation/outlines-editor';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import type { SceneOutline } from '@/lib/types/generation';
import { AgentRevealModal } from '@/components/agent/agent-reveal-modal';
import { createLogger } from '@/lib/logger';
import { RunApiError, runApiErrorText } from '@/lib/generation-run-client/api';
import { toast } from 'sonner';
import { runFailureText, type FailureText } from '@/lib/generation-run-client/failure-message';
import { confirmOutline, retryPausedRun } from '@/lib/generation-run-client/commands';
import {
  createAutoContinue,
  forgetRunStartedHere,
  nextPreviewPhase,
  type PreviewPhase,
  wasRunStartedHere,
} from '@/lib/generation-run-client/outline-review';
import { previewStepIds, previewStepIndex } from '@/lib/generation-run-client/preview-steps';
import { visibleOutlines } from '@/lib/generation-run-client/reducer';
import { useGenerationRun } from '@/lib/generation-run-client/use-generation-run';
import { ALL_STEPS, getGenerationStepText } from './types';
import { StepVisualizer } from './components/visualizers';

const log = createLogger('GenerationPreview');

/** The learner opened the outline review of this run (kept across a reload of the page). */
function reviewIntentKey(runId: string): string {
  return `generationRunReviewIntent:${runId}`;
}

function readReviewIntent(runId: string): boolean {
  try {
    return sessionStorage.getItem(reviewIntentKey(runId)) === '1';
  } catch {
    return false;
  }
}

function writeReviewIntent(runId: string, intent: boolean): void {
  try {
    if (intent) sessionStorage.setItem(reviewIntentKey(runId), '1');
    else sessionStorage.removeItem(reviewIntentKey(runId));
  } catch {
    /* sessionStorage unavailable: the intent lasts for this page only */
  }
}

function GenerationPreviewContent() {
  const router = useRouter();
  const { t } = useI18n();
  const runId = useSearchParams().get('run');
  const { view, status, caughtUp, refresh } = useGenerationRun(runId);
  const capabilities = useModelCapabilities();

  // The 2.5 s auto-continue: it confirms the outline it was armed with.
  const sendConfirmRef = useRef<(edits: SceneOutline[] | null) => void>(() => {});
  const [autoContinue] = useState(() =>
    createAutoContinue<SceneOutline[] | null>((edits) => sendConfirmRef.current(edits)),
  );
  // Sticky: true once the learner opens the review (mid-stream or after),
  // until they collapse it again. Combined with `reviewOutlineEnabled` to
  // decide whether the outline waits for them or auto-continues.
  const outlineReviewIntentRef = useRef(false);
  // The phase the outline step is shown in: the streaming card, the
  // outline-ready card counting down to auto-continue, or the review editor.
  const [phase, setPhase] = useState<PreviewPhase>('progress');
  const [editedOutlines, setEditedOutlines] = useState<SceneOutline[] | null>(null);
  const [isConfirmingOutlines, setIsConfirmingOutlines] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  // This page's confirmation lost to one made elsewhere: its edits stay shown.
  const [confirmConflict, setConfirmConflict] = useState(false);
  // The seq of a step Retry: the run shows as retrying until a step starts after it.
  const [retrySeq, setRetrySeq] = useState<number | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [showAgentReveal, setShowAgentReveal] = useState(false);
  // The agent cards were shown and are still being revealed: the classroom
  // waits for them, as generation did.
  const [agentRevealPending, setAgentRevealPending] = useState(false);
  const agentRevealShownRef = useRef(false);
  // Whether this page has caught up with the run yet.
  const attachedRef = useRef(false);
  const reviewOutlineEnabled = useSettingsStore((s) => s.reviewOutlineEnabled);
  const setReviewOutlineEnabled = useSettingsStore((s) => s.setReviewOutlineEnabled);

  const clearOutlineReviewTimer = () => autoContinue.cancel();

  useEffect(() => {
    if (runId) outlineReviewIntentRef.current = readReviewIntent(runId);
    return () => autoContinue.cancel();
  }, [runId, autoContinue]);

  const steps = useMemo(() => {
    if (!view) return [];
    const ids = previewStepIds({
      // The analysis step shows until the materials are analyzed, as it did.
      hasMaterials: view.input.materialIds.length > 0 && !view.materialsAnalyzed,
      webSearch: !!capabilities.webSearch,
      autoAgents: view.input.agents.mode === 'auto',
    });
    return ids.map((id) => ALL_STEPS.find((step) => step.id === id)!);
  }, [view, capabilities.webSearch]);
  const currentStepIndex = view
    ? previewStepIndex(
        view,
        steps.map((step) => step.id),
      )
    : 0;

  const outlines = view ? visibleOutlines(view) : [];
  const isOutlineStreaming =
    !!view && (view.state === 'preparing' || view.state === 'outlining') && !view.outline;
  const awaitingConfirmation = view?.state === 'awaiting_outline_confirmation';

  const sendConfirm = async (edits: SceneOutline[] | null) => {
    if (!view?.outline) return;
    clearOutlineReviewTimer();
    setIsConfirmingOutlines(true);
    setCommandError(null);
    try {
      await confirmOutline(view, edits ?? undefined);
      outlineReviewIntentRef.current = false;
      writeReviewIntent(view.runId, false);
      forgetRunStartedHere(view.runId);
      setPhase('progress');
      void refresh();
      // The learner committed to the course: the homepage draft can go. Before
      // this point, "back to requirements" must restore their input.
      try {
        localStorage.removeItem('requirementDraft');
      } catch {
        /* ignore */
      }
    } catch (error) {
      log.warn('Confirming the outline failed:', error);
      if (error instanceof RunApiError && error.errorCode === 'RUN_STATE_CONFLICT') {
        // Confirmed (or changed) elsewhere: what the learner edited here stays
        // in view, with what happened.
        if (edits) {
          setConfirmConflict(true);
          setPhase('review');
          setCommandError(t('generation.outlineConfirmedElsewhere'));
        }
        await refresh();
      } else if (error instanceof RunApiError) {
        setCommandError(runApiErrorText(error, t));
      } else {
        setCommandError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setIsConfirmingOutlines(false);
    }
  };
  useEffect(() => {
    sendConfirmRef.current = (edits) => void sendConfirm(edits);
  });

  const armAutoContinue = (edits: SceneOutline[] | null) => autoContinue.arm(edits);

  // The outline is ready and the run waits for it. The tab whose composer
  // started the run keeps the classic pacing (the review when the learner
  // asked for it, else a 2.5 s beat on the outline-ready card); any other tab
  // shows the review.
  useEffect(() => {
    if (!view || !caughtUp) return;
    const firstAttach = !attachedRef.current;
    attachedRef.current = true;
    const next = nextPreviewPhase({
      phase,
      state: view.state,
      outlineStreaming: isOutlineStreaming,
      hasOutline: !!view.outline,
      firstAttach,
      startedHere: wasRunStartedHere(view.runId),
      reviewOutlineEnabled: useSettingsStore.getState().reviewOutlineEnabled,
      reviewIntent: outlineReviewIntentRef.current,
      confirmConflict,
    });
    if (next.cancelAutoContinue) clearOutlineReviewTimer();
    if (next.phase !== phase) setPhase(next.phase);
    if (next.armAutoContinue) armAutoContinue(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.state, caughtUp]);

  // The generated roster's cards, revealed as generation goes on.
  useEffect(() => {
    if (!view?.generatedAgents || agentRevealShownRef.current) return;
    if (view.input.agents.mode !== 'auto' || view.stageId) return;
    agentRevealShownRef.current = true;
    setAgentRevealPending(true);
    setShowAgentReveal(true);
  }, [view?.generatedAgents, view?.input.agents.mode, view?.stageId]);

  // The first scene is in the course: the classroom takes over.
  useEffect(() => {
    if (!view?.stageId || agentRevealPending) return;
    if (view.state === 'ended') return;
    router.replace(`/classroom/${encodeURIComponent(view.stageId)}`);
  }, [view?.stageId, view?.state, agentRevealPending, router]);

  // A Retry is queued until a step starts after it (a media item in flight
  // finishes first).
  const retryQueued =
    !!view && retrySeq !== null && view.state !== 'paused' && view.stepStartedSeq <= retrySeq;

  const handleRetry = async () => {
    if (!view || isRetrying) return;
    setIsRetrying(true);
    setCommandError(null);
    try {
      setRetrySeq(await retryPausedRun(view));
      void refresh();
    } catch (error) {
      log.warn('Retrying the run failed:', error);
      if (error instanceof RunApiError && error.errorCode === 'RUN_STATE_CONFLICT') {
        // Retried (or changed) elsewhere.
        toast.info(t('generation.runChangedElsewhere'));
        await refresh();
      } else if (error instanceof RunApiError) {
        setCommandError(runApiErrorText(error, t));
      } else {
        setCommandError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setIsRetrying(false);
    }
  };

  // Leaving does not stop the run: its course card goes on showing it.
  const goBackToHome = () => {
    clearOutlineReviewTimer();
    router.push('/');
  };

  // Triggered when the user clicks the streaming outline card mid-stream.
  const handleExpandStreamingOutline = () => {
    if (!view) return;
    clearOutlineReviewTimer();
    outlineReviewIntentRef.current = true;
    writeReviewIntent(view.runId, true);
    setPhase('review');
  };

  // Inverse of expand. Mid-stream: shrink back to the streaming preview card.
  // Post-stream: shrink back to the small card too, then re-arm the 2.5s
  // auto-continue timer — same pacing as the no-review path.
  const handleCollapseEditor = () => {
    if (!view) return;
    outlineReviewIntentRef.current = false;
    writeReviewIntent(view.runId, false);
    if (isOutlineStreaming) {
      setPhase('progress');
      return;
    }
    if (!awaitingConfirmation) return;
    setPhase('outline-ready');
    armAutoContinue(editedOutlines);
  };

  const handleOutlinesChange = (next: SceneOutline[]) => {
    // The editor is read-only while the outline streams.
    if (isOutlineStreaming) return;
    setEditedOutlines(next);
  };

  const handleConfirmOutlines = () => {
    // The outline was confirmed elsewhere: follow the run as it goes.
    if (confirmConflict) {
      setConfirmConflict(false);
      setCommandError(null);
      setPhase('progress');
      return;
    }
    const finalOutlines = editedOutlines ?? outlines;
    if (finalOutlines.length === 0) return;
    void sendConfirm(editedOutlines);
  };

  // The run cannot be read now; the page keeps trying.
  if (status === 'error' && runId) {
    return (
      <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <Card className="p-8 max-w-md w-full">
          <div className="text-center space-y-4">
            <div className="size-8 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin mx-auto" />
            <h2 className="text-xl font-semibold">{t('generation.runLoadFailed')}</h2>
            <p className="text-sm text-muted-foreground">{t('generation.runLoadRetrying')}</p>
            <Button variant="outline" onClick={() => router.push('/')} className="w-full">
              <ArrowLeft className="size-4 mr-2" />
              {t('generation.backToHome')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // Still reading the run
  if (status === 'loading' && runId) {
    return (
      <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <div className="text-center text-muted-foreground">
          <div className="size-8 border-2 border-current border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      </div>
    );
  }

  // No run (or it was discarded)
  if (!view || status === 'missing' || view.state === 'ended') {
    return (
      <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
        <Card className="p-8 max-w-md w-full">
          <div className="text-center space-y-4">
            <AlertCircle className="size-12 text-muted-foreground mx-auto" />
            <h2 className="text-xl font-semibold">{t('generation.sessionNotFound')}</h2>
            <p className="text-sm text-muted-foreground">{t('generation.sessionNotFoundDesc')}</p>
            <Button onClick={() => router.push('/')} className="w-full">
              <ArrowLeft className="size-4 mr-2" />
              {t('generation.backToHome')}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const failureSentence = (text: FailureText) => ('key' in text ? t(text.key) : text.text);
  const isReviewingOutlines = phase === 'review';
  const isOutlineReady = phase === 'outline-ready';
  const error =
    commandError ??
    (view.state === 'paused' && view.error ? failureSentence(runFailureText(view.error)) : null);
  const paused = view.state === 'paused';
  const statusMessage = view.outlineRetrying
    ? t('generation.outlineRetrying')
    : retryQueued
      ? t('generation.retryingScene')
      : isOutlineReady
        ? t('generation.reviewOutlineAutoContinue')
        : '';
  const webSearchSources = view.researchSources;
  const generatedAgents = view.generatedAgents ?? [];

  const activeStep =
    steps.length > 0 ? steps[Math.min(currentStepIndex, steps.length - 1)] : ALL_STEPS[0];
  // Audio or video is "Analyzing audio/video", by the first material, as before.
  const activeStepText = getGenerationStepText(
    activeStep,
    view.materialKinds?.[0] === 'media' ? { documentMimeType: 'audio/' } : null,
  );
  const truncationWarnings = [
    ...(view.materialTruncated?.textChars !== undefined
      ? [t('generation.textTruncated', { n: view.materialTruncated.textChars })]
      : []),
    ...(view.materialTruncated?.images
      ? [
          t('generation.imageTruncated', {
            total: view.materialTruncated.images.total,
            max: view.materialTruncated.images.max,
          }),
        ]
      : []),
  ];

  if (isReviewingOutlines) {
    const outlineStepIndex = Math.max(
      0,
      steps.findIndex((step) => step.id === 'outline'),
    );
    // Editor source-of-truth: the learner's edit; else the run's outline (the
    // streamed items until it is ready).
    const editorOutlines = editedOutlines ?? outlines;

    return (
      <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex flex-col items-center p-4 relative overflow-hidden">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute top-4 left-4 z-20"
        >
          <Button variant="ghost" size="sm" onClick={goBackToHome} disabled={isConfirmingOutlines}>
            <ArrowLeft className="size-4 mr-2" />
            {t('generation.backToHome')}
          </Button>
        </motion.div>

        <div className="z-10 w-full max-w-3xl pt-16 pb-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            <div className="flex justify-center gap-2">
              {steps.map((step, idx) => (
                <div
                  key={step.id}
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-500',
                    idx < outlineStepIndex
                      ? 'w-1.5 bg-blue-500/30'
                      : idx === outlineStepIndex
                        ? 'w-8 bg-blue-500'
                        : 'w-1.5 bg-muted/50',
                  )}
                />
              ))}
            </div>

            <div className="max-w-2xl space-y-2 text-center mx-auto">
              <h2 className="text-2xl font-bold tracking-tight">
                {t('generation.reviewOutlineTitle')}
              </h2>
              <p className="text-muted-foreground text-sm md:text-base">
                {isOutlineStreaming
                  ? t('generation.reviewOutlineStreamingDesc')
                  : t('generation.reviewOutlineDesc')}
              </p>
            </div>

            {error && (
              <div className="mx-auto max-w-2xl rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-300">
                {error}
              </div>
            )}

            <OutlinesEditor
              outlines={editorOutlines}
              onChange={handleOutlinesChange}
              onConfirm={handleConfirmOutlines}
              onBack={goBackToHome}
              alwaysReview={reviewOutlineEnabled}
              onAlwaysReviewChange={setReviewOutlineEnabled}
              isLoading={isConfirmingOutlines}
              isStreaming={isOutlineStreaming}
              onCollapse={handleCollapseEditor}
            />
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex flex-col items-center justify-center p-4 relative overflow-hidden text-center">
      {/* Background Decor */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div
          className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '4s' }}
        />
        <div
          className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '6s' }}
        />
      </div>

      {/* Back button */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="absolute top-4 left-4 z-20"
      >
        <Button variant="ghost" size="sm" onClick={goBackToHome}>
          <ArrowLeft className="size-4 mr-2" />
          {t('generation.backToHome')}
        </Button>
      </motion.div>

      <div className="z-10 w-full max-w-lg space-y-8 flex flex-col items-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="w-full"
        >
          <Card className="relative overflow-hidden border-muted/40 shadow-2xl bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl min-h-[400px] flex flex-col items-center justify-center p-8 md:p-12">
            {/* Progress Dots */}
            <div className="absolute top-6 left-0 right-0 flex justify-center gap-2">
              {steps.map((step, idx) => (
                <div
                  key={step.id}
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-500',
                    idx < currentStepIndex
                      ? 'w-1.5 bg-blue-500/30'
                      : idx === currentStepIndex
                        ? 'w-8 bg-blue-500'
                        : 'w-1.5 bg-muted/50',
                  )}
                />
              ))}
            </div>

            {/* Central Content */}
            <div className="flex-1 flex flex-col items-center justify-center w-full space-y-8 mt-4">
              {/* Icon / Visualizer Container */}
              <div className="relative size-48 flex items-center justify-center">
                <AnimatePresence mode="popLayout">
                  {error ? (
                    <motion.div
                      key="error"
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="size-32 rounded-full bg-red-500/10 flex items-center justify-center border-2 border-red-500/20"
                    >
                      <AlertCircle className="size-16 text-red-500" />
                    </motion.div>
                  ) : (
                    <motion.div
                      key={activeStep.id}
                      initial={{ scale: 0.8, opacity: 0, filter: 'blur(10px)' }}
                      animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                      exit={{ scale: 1.2, opacity: 0, filter: 'blur(10px)' }}
                      transition={{ duration: 0.4 }}
                      className="absolute inset-0 flex items-center justify-center"
                    >
                      <StepVisualizer
                        stepId={activeStep.id}
                        outlines={outlines}
                        webSearchSources={webSearchSources}
                        onExpandOutline={
                          activeStep.id === 'outline' ? handleExpandStreamingOutline : undefined
                        }
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Text Content */}
              <div className="space-y-3 max-w-sm mx-auto">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={error ? 'error' : activeStep.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="space-y-2"
                  >
                    <h2 className="text-2xl font-bold tracking-tight">
                      {error
                        ? t('generation.generationFailed')
                        : t(activeStepText.title, activeStepText.titleValues)}
                    </h2>
                    <p className="text-muted-foreground text-base">
                      {error ? error : statusMessage || t(activeStepText.description)}
                    </p>
                  </motion.div>
                </AnimatePresence>

                {/* Truncation warning indicator */}
                <AnimatePresence>
                  {truncationWarnings.length > 0 && !error && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0 }}
                      transition={{
                        type: 'spring',
                        stiffness: 500,
                        damping: 30,
                      }}
                      className="flex justify-center"
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <motion.button
                            type="button"
                            animate={{
                              boxShadow: [
                                '0 0 0 0 rgba(251, 191, 36, 0), 0 0 0 0 rgba(251, 191, 36, 0)',
                                '0 0 16px 4px rgba(251, 191, 36, 0.12), 0 0 4px 1px rgba(251, 191, 36, 0.08)',
                                '0 0 0 0 rgba(251, 191, 36, 0), 0 0 0 0 rgba(251, 191, 36, 0)',
                              ],
                            }}
                            transition={{
                              duration: 3,
                              repeat: Infinity,
                              ease: 'easeInOut',
                            }}
                            className="relative size-7 rounded-full flex items-center justify-center cursor-default
                                       bg-gradient-to-br from-amber-400/15 to-orange-400/10
                                       border border-amber-400/25 hover:border-amber-400/40
                                       hover:from-amber-400/20 hover:to-orange-400/15
                                       transition-colors duration-300
                                       focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/30"
                          >
                            <AlertTriangle
                              className="size-3.5 text-amber-500 dark:text-amber-400"
                              strokeWidth={2.5}
                            />
                          </motion.button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" sideOffset={6}>
                          <div className="space-y-1 py-0.5">
                            {truncationWarnings.map((w, i) => (
                              <p key={i} className="text-xs leading-relaxed">
                                {w}
                              </p>
                            ))}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </Card>
        </motion.div>

        {/* Footer Action */}
        <div className="h-16 flex items-center justify-center w-full">
          <AnimatePresence>
            {error ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex w-full max-w-sm gap-3"
              >
                {paused && (
                  <Button
                    size="lg"
                    className="h-12 flex-1"
                    onClick={handleRetry}
                    disabled={isRetrying}
                    data-testid="generation-retry"
                  >
                    <RefreshCw className={cn('size-4 mr-2', isRetrying && 'animate-spin')} />
                    {t('generation.retryScene')}
                  </Button>
                )}
                <Button size="lg" variant="outline" className="h-12 flex-1" onClick={goBackToHome}>
                  {paused ? t('generation.backToHome') : t('generation.goBackAndRetry')}
                </Button>
              </motion.div>
            ) : !isOutlineReady ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-3 text-sm text-muted-foreground/50 font-medium uppercase tracking-widest"
              >
                <Sparkles className="size-3 animate-pulse" />
                {t('generation.aiWorking')}
                {generatedAgents.length > 0 && !showAgentReveal && (
                  <button
                    onClick={() => setShowAgentReveal(true)}
                    className="ml-2 flex items-center gap-1.5 rounded-full border border-purple-300/30 bg-purple-500/10 px-3 py-1 text-xs font-medium normal-case tracking-normal text-purple-400 transition-colors hover:bg-purple-500/20 hover:text-purple-300"
                  >
                    <Bot className="size-3" />
                    {t('generation.viewAgents')}
                  </button>
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      {/* Agent Reveal Modal */}
      <AgentRevealModal
        agents={generatedAgents}
        open={showAgentReveal}
        onClose={() => {
          setShowAgentReveal(false);
          setAgentRevealPending(false);
        }}
        onAllRevealed={() => setAgentRevealPending(false)}
      />
    </div>
  );
}

export default function GenerationPreviewPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center">
          <div className="animate-pulse space-y-4 text-center">
            <div className="h-8 w-48 bg-muted rounded mx-auto" />
            <div className="h-4 w-64 bg-muted rounded mx-auto" />
          </div>
        </div>
      }
    >
      <GenerationPreviewContent />
    </Suspense>
  );
}
