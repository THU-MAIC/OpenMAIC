'use client';

/**
 * ClassroomSurface — the classroom, wherever it is mounted.
 *
 * This is the body `/classroom/[id]` has always had: the load pipeline, the
 * generation-resume policy and the `Stage` dispatch under `ThemeProvider` /
 * `MediaStageProvider`. It moved out of the route file for exactly one reason
 * — the Pro workspace's third pane hosts the REAL classroom, not a preview and
 * not an iframe, so both surfaces must run the same code rather than two
 * copies that drift.
 *
 * `variant` is only layout/load-context: `page` fills the viewport and treats
 * a course that cannot be found as terminal; `pane` fills its column and runs
 * a bounded availability probe because a newly linked course may be committed
 * shortly afterward. Neither host accepts conversation/session state. A
 * classroom's lifecycle is keyed only by its course id; document and manifest
 * data then converge in place as writers update them.
 *
 * The reference (live deployment) additionally runs non-owner visitor
 * hydration, a transport-persistence UI fence and a background uploader; all
 * three depend on server-side machinery this workspace does not have, so they
 * are dropped and the load follows the ordinary path
 * (`app/classroom/[id]/page.tsx`). The stage-meta sidecar is still consulted:
 * both variants gate generation on ownership, and the standalone page also
 * applies its viewer-specific edit access.
 */

import { Stage } from '@/components/stage';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { claimStageSceneLoadToken, isCurrentStageSceneLoadToken } from '@/lib/store/stage';
import { loadImageMapping } from '@/lib/utils/image-storage';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { clearNarrationAllocations } from '@/lib/audio/narration-allocations';
import { useNarrationAdoption } from '@/lib/audio/use-narration-adoption';
import { clearPendingMediaAllocations } from '@/lib/media/pending-media-allocations';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { useCanvasStore } from '@/lib/store/canvas';
import { createLogger } from '@/lib/logger';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { useI18n } from '@/lib/hooks/use-i18n';
import { FileQuestion, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import {
  applyClassroomStageAndScenes,
  defaultClassroomLoadDeps,
  runClassroomLoad,
} from '@/lib/classroom/load-classroom';
import {
  paneAvailabilityRetryDelay,
  resolveClassroomSurfaceView,
  shouldResumeClassroomGeneration,
} from '@/lib/classroom/progressive-load-policy';
import { fetchStageMeta } from '@/lib/classroom/stage-meta-client';
import {
  classroomGenerationOwnership,
  noteStageOwnership,
  retryWhileOwnershipUnresolved,
  type ClassroomGenerationOwnership,
} from '@/lib/classroom/stage-ownership-signal';
import {
  noteStageGenerationOwnership,
  useMayGenerateForStage,
} from '@/lib/classroom/generation-permission';
import { isServerBackedMediaPersistence } from '@/lib/persistence/media-persistence';

const log = createLogger('Classroom');

type ClassroomLoadOutcome = 'loaded' | 'unavailable' | 'absent' | 'failed' | 'cancelled';
const LOAD_UNAVAILABLE_ERROR = 'load-unavailable';

// stage_link can become visible shortly before its document. Probe only that
// explicit availability gap, with a small bounded backoff; media conversion
// and ordinary failures never enter this schedule.
export function ClassroomSurface({
  classroomId,
  variant = 'page',
}: {
  readonly classroomId: string;
  readonly variant?: 'page' | 'pane';
}) {
  const { loadFromStorage } = useStageStore();
  const loadedClassroomId = useStageStore((s) => s.stage?.id ?? null);
  const { t } = useI18n();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadUnavailable, setLoadUnavailable] = useState(false);
  /**
   * The load resolved and no source has this course. A TERMINAL state, kept
   * separate from `error`: an error offers a retry, and there is nothing here
   * to retry.
   *
   * The copy it renders is deliberately the SAME whether the course was
   * deleted or never existed.
   */
  const [notFound, setNotFound] = useState(false);
  /**
   * Whether this browser may start generation for this course, from the shared
   * permission store the stage-meta sidecar feeds. Gates the resume effect and
   * the outline-retry affordance alike, so what is offered and what is allowed
   * cannot diverge.
   */
  const mayGenerate = useMayGenerateForStage(classroomId);

  const generationStartedRef = useRef(false);
  const activeClassroomIdRef = useRef<string | null>(null);
  const loadEpochRef = useRef(0);

  const { generateRemaining, retrySingleOutline, stop } = useSceneGenerator({
    onComplete: () => {
      log.info('[Classroom] All scenes generated');
    },
  });

  const loadClassroom = useCallback(
    async (isEffectCurrent: () => boolean): Promise<ClassroomLoadOutcome> => {
      const loadToken = claimStageSceneLoadToken();
      const isCurrent = () => isEffectCurrent() && isCurrentStageSceneLoadToken(loadToken);

      try {
        const loadResult = await runClassroomLoad({
          classroomId,
          loadToken,
          isCurrent,
          loadFromStorage,
          getCurrentStage: () => useStageStore.getState().stage,
          fetchClassroom: defaultClassroomLoadDeps.fetchClassroom,
          applyFallbackScenes: (args) =>
            defaultClassroomLoadDeps.applyFallbackScenes({
              ...args,
              isCurrent,
              applyStageAndScenes: applyClassroomStageAndScenes,
            }),
          loadRestoredMediaTasks: defaultClassroomLoadDeps.loadRestoredMediaTasks,
          applyRestoredMediaTasks: (restored) =>
            defaultClassroomLoadDeps.applyRestoredMediaTasks(restored, isCurrent),
          discardRestoredMediaTasks: defaultClassroomLoadDeps.discardRestoredMediaTasks,
          loadLegacyAgentFallbacks: defaultClassroomLoadDeps.loadLegacyAgentFallbacks,
          commitMigratedAgentConfigs: defaultClassroomLoadDeps.commitMigratedAgentConfigs,
          applyGeneratedAgents: defaultClassroomLoadDeps.applyGeneratedAgents,
          getSettings: () => useSettingsStore.getState(),
          getAgent: (id) => useAgentRegistry.getState().getAgent(id),
          restoreAgentSelection: defaultClassroomLoadDeps.restoreAgentSelection,
          setError,
          setLoading,
          log,
        });
        if (!isCurrent()) return 'cancelled';

        // Positive absence only: the course is gone, invalid, or never
        // existed. Other failures stay on the error/retry path so we never
        // claim "not found" without a positive answer (#1450).
        if (loadResult.outcome === 'absent') {
          if (variant === 'page') {
            setNotFound(true);
          }
          // Inside the workspace the pane treats a miss as the bounded
          // availability gap (stage_link can land before the document).
          return 'absent';
        }

        if (loadResult.outcome === 'unavailable') {
          if (variant === 'pane') {
            // Retry through the availability schedule; exhaustion lands on the
            // error card with Retry, not the not-found claim.
            return 'unavailable';
          }
          setLoadUnavailable(true);
          setError(LOAD_UNAVAILABLE_ERROR);
          setLoading(false);
          return 'failed';
        }

        if (loadResult.outcome === 'cancelled') return 'cancelled';
        if (loadResult.outcome === 'failed') return 'failed';

        // Defensive: a "ready" load that somehow left the wrong course in the
        // store still must not become not-found.
        if (useStageStore.getState().stage?.id !== classroomId) {
          if (variant === 'pane') return 'unavailable';
          setLoadUnavailable(true);
          setError(LOAD_UNAVAILABLE_ERROR);
          setLoading(false);
          return 'failed';
        }
        return 'loaded';
      } catch (error) {
        log.error('Failed to load classroom:', error);
        if (isCurrent()) {
          setLoadUnavailable(false);
          setError(error instanceof Error ? error.message : 'Failed to load classroom');
          setLoading(false);
        }
        return isCurrent() ? 'failed' : 'cancelled';
      }
    },
    [classroomId, loadFromStorage, variant],
  );

  const refreshOwnership = useCallback(
    (isCurrent: () => boolean) => {
      if (!isCurrent() || !isServerBackedMediaPersistence()) return;

      const askOwnership = async (): Promise<ClassroomGenerationOwnership> => {
        try {
          const result = await fetchStageMeta(classroomId);
          if (!isCurrent()) return 'unresolved';
          const ownership = classroomGenerationOwnership(result);
          noteStageGenerationOwnership(classroomId, ownership);

          // The standalone route also uses the sidecar to set edit access. The
          // hosted pane owns that decision at its workspace boundary.
          if (variant === 'page') {
            if (result.outcome === 'found') {
              noteStageOwnership(classroomId, true, { isOwner: result.meta.isOwner });
              useStageStore.getState().setViewerAccess({ isOwner: result.meta.isOwner });
            } else if (result.outcome === 'unavailable') {
              noteStageOwnership(classroomId, false, null);
            } else {
              noteStageOwnership(classroomId, true, null);
            }
          }
          return ownership;
        } catch {
          if (!isCurrent()) return 'unresolved';
          noteStageGenerationOwnership(classroomId, 'unresolved');
          if (variant === 'page') noteStageOwnership(classroomId, false, null);
          return 'unresolved';
        }
      };

      void retryWhileOwnershipUnresolved(askOwnership, { isCurrent });
    },
    [classroomId, variant],
  );

  const retryClassroom = useCallback(() => {
    const loadEpoch = loadEpochRef.current + 1;
    loadEpochRef.current = loadEpoch;
    const isCurrent = () =>
      activeClassroomIdRef.current === classroomId && loadEpochRef.current === loadEpoch;
    setError(null);
    setLoadUnavailable(false);
    setNotFound(false);
    setLoading(true);

    void loadClassroom(isCurrent).then((outcome) => {
      if (!isCurrent()) return;
      if (outcome === 'loaded') {
        refreshOwnership(isCurrent);
        return;
      }
      if (variant === 'pane' && (outcome === 'unavailable' || outcome === 'absent')) {
        setLoading(false);
        if (outcome === 'absent') {
          setNotFound(true);
        } else {
          setLoadUnavailable(true);
          setError(LOAD_UNAVAILABLE_ERROR);
        }
      }
    });
  }, [classroomId, loadClassroom, refreshOwnership, variant]);

  useEffect(() => {
    let cancelled = false;
    const loadEpoch = loadEpochRef.current + 1;
    loadEpochRef.current = loadEpoch;
    activeClassroomIdRef.current = classroomId;
    const isCurrent = () =>
      !cancelled &&
      activeClassroomIdRef.current === classroomId &&
      loadEpochRef.current === loadEpoch;

    // Reset loading state on course switch to unmount Stage during transition,
    // preventing stale data from syncing back to the new course
    /* eslint-disable react-hooks/set-state-in-effect -- Course switch must hide stale Stage before async load */
    setLoading(true);
    setError(null);
    setLoadUnavailable(false);
    setNotFound(false);
    /* eslint-enable react-hooks/set-state-in-effect */
    // Ownership belongs to the departing course; the new one must re-earn it
    // before anything it holds may be generated.
    noteStageGenerationOwnership(classroomId, 'unresolved');
    generationStartedRef.current = false;

    // Clear previous classroom's media tasks to prevent cross-classroom contamination.
    // Placeholder IDs (gen_img_1, gen_vid_1) are NOT globally unique across stages,
    // so stale tasks from a previous classroom would shadow the new one's.
    const mediaStore = useMediaGenerationStore.getState();
    mediaStore.revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });
    // Allocations parked by an interrupted run on THIS id must go with them.
    // Classic placeholders are reused across runs of the same course, so a
    // survivor would be handed to a different slide of the next deck.
    clearPendingMediaAllocations(classroomId);
    clearNarrationAllocations(classroomId);

    // Clear whiteboard history to prevent snapshots from a previous course leaking in.
    useWhiteboardHistoryStore.getState().clearHistory();

    // Reset edit-time canvas selection/scale: the classroom load paths set
    // mode:'playback' via raw setState (not setMode), so an unfinished Pro-mode
    // session in the previous course wouldn't otherwise clear its canvas state.
    useCanvasStore.getState().resetCanvasState();

    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let availabilityAttempt = 0;
    /** Last pane gap reason — exhaustion must not claim not-found after a load error. */
    let lastGap: 'absent' | 'unavailable' | null = null;

    // Asked only AFTER a document load succeeds, and again after every later
    // one, mirroring the page route. The load is what brings a course into the
    // server store the first time it is opened, so asking beforehand asks about
    // a course whose ownership row does not exist yet: the 404 that comes back
    // would lock its genuine author out of generation and of every retry
    // control for the rest of the mount. The gate stays closed until an answer
    // arrives, so asking again can only ever open it for someone entitled to it.
    const loadUntilAvailable = async () => {
      if (!isCurrent()) return;
      // A previous pane attempt may have observed a transient read failure.
      // Clear only its presentation before retrying; do not raise `loading`
      // again, so an already mounted classroom never flashes away.
      if (variant === 'pane') setError(null);
      const outcome = await loadClassroom(isCurrent);
      if (!isCurrent()) return;

      if (outcome === 'absent' || outcome === 'unavailable') {
        lastGap = outcome;
        if (variant === 'pane') {
          const delay = paneAvailabilityRetryDelay(availabilityAttempt);
          availabilityAttempt += 1;
          if (delay !== null) {
            retryTimer = setTimeout(loadUntilAvailable, delay);
            return;
          }
          setLoading(false);
          if (lastGap === 'unavailable') {
            setLoadUnavailable(true);
            setError(LOAD_UNAVAILABLE_ERROR);
          } else {
            setNotFound(true);
          }
          return;
        }
      }

      // The document is now loaded, so the sidecar has something to say about
      // this course. Absence and load failures must not establish ownership.
      if (outcome === 'loaded') {
        refreshOwnership(isCurrent);
      }
    };
    void loadUntilAvailable();

    // Cancel ongoing generation when classroomId changes or component unmounts
    return () => {
      cancelled = true;
      if (loadEpochRef.current === loadEpoch) {
        loadEpochRef.current += 1;
      }
      if (activeClassroomIdRef.current === classroomId) {
        activeClassroomIdRef.current = null;
      }
      if (retryTimer) clearTimeout(retryTimer);
      stop();
    };
  }, [classroomId, loadClassroom, refreshOwnership, stop, variant]);

  // Narration written before this application stored media server-side is a
  // derived key that only this browser can resolve. Both classroom surfaces
  // mount this, so a course opened through the workbench pane converges its
  // narration exactly as the standalone page does.
  useNarrationAdoption(classroomId, { ready: !loading && !error, mayGenerate });

  // Auto-resume generation for pending outlines (owner only). Two independent
  // ownership facts gate it. The sidecar's per-viewer answer decides whether
  // this browser may spend the operator's provider budget at all, and fails
  // closed while unanswered; `generationStartedRef` is deliberately NOT
  // latched while it refuses, so the effect starts once the answer arrives.
  // `outlineProducer` then decides whether the browser is the producer: a
  // course whose document a server job produced is server-owned, not
  // client-authored, and therefore not this browser's to regenerate. The
  // reference's transport-persistence UI fence has no counterpart here, so it
  // stays a constant false.
  useEffect(() => {
    if (
      !shouldResumeClassroomGeneration({
        loading,
        error,
        transportPersistenceFenced: false,
        generationStarted: generationStartedRef.current,
        mayGenerate,
      })
    ) {
      return;
    }
    const state = useStageStore.getState();
    // Producer ownership is document data, not conversation status. A
    // server-job course never starts a second browser-side generator no matter
    // which chat is open (or whether any chat is open).
    if (state.outlineProducer === 'server-job') {
      generationStartedRef.current = true;
      log.info('[Classroom] A server-side job owns this course; the browser will not generate.');
      return;
    }

    const { outlines, scenes, stage, generationComplete } = state;

    // Check if there are pending outlines. A finished deck is frozen for
    // editing: deleting a slide leaves its outline orphaned, but that must not
    // be treated as an interrupted generation and regenerated. Only resume
    // when generation has not completed.
    const completedOrders = new Set(scenes.map((s) => s.order));
    const hasPending = !generationComplete && outlines.some((o) => !completedOrders.has(o.order));

    if (hasPending && stage) {
      generationStartedRef.current = true;

      // Load generation params from sessionStorage (stored by generation-preview before navigating)
      const genParamsStr = sessionStorage.getItem('generationParams');
      const params = genParamsStr ? JSON.parse(genParamsStr) : {};

      // Reconstruct imageMapping for the resumed generation. The mapping may
      // MIX allocated asset ids and IndexedDB data URLs — a source whose cache
      // write failed materialized its own images — so the resume mapping merges
      // both, instead of choosing one transport for the whole set and silently
      // dropping the other half.
      const pdfImages = (params.pdfImages || []) as Array<
        { id: string; assetId?: string; storageId?: string } & Record<string, unknown>
      >;
      const finishResume = (imageMapping: Record<string, string>) =>
        generateRemaining({
          pdfImages: params.pdfImages,
          imageMapping,
          stageInfo: {
            name: stage.name || '',
            description: stage.description,
            style: stage.style,
          },
          agents: params.agents,
          userProfile: params.userProfile,
          languageDirective: params.languageDirective || stage.languageDirective,
        });

      const imageMapping: Record<string, string> = {};
      for (const img of pdfImages) {
        if (img.assetId) imageMapping[img.id] = img.assetId;
      }
      const storageIds = pdfImages
        .filter((img) => !img.assetId && img.storageId)
        .map((img) => img.storageId as string);
      void (async () => {
        if (storageIds.length > 0) {
          Object.assign(imageMapping, await loadImageMapping(storageIds));
        }
        finishResume(imageMapping);
      })();
    } else if (outlines.length > 0 && stage) {
      // All scenes are generated, but some media may not have finished.
      // Resume media generation for any tasks not yet in IndexedDB.
      // generateMediaForOutlines skips already-completed tasks automatically.
      generationStartedRef.current = true;
      // The deck reached the classroom already fully materialized (e.g. a
      // single-slide course, or a deck whose last slide finished in
      // generation-preview), so generateRemaining's completion path never
      // ran. Record completion now so a later edit/delete is not treated as
      // an interrupted generation. No-op if already complete or not all
      // outlines have scenes.
      useStageStore.getState().markGenerationCompleteIfDone();
      // Resume media only for outlines that still have a scene. On a finished
      // deck the user may have deleted a slide, leaving an orphaned outline;
      // generating its media would waste API calls on a slide that is gone.
      const materializedOrders = new Set(scenes.map((s) => s.order));
      const materializedOutlines = outlines.filter((o) => materializedOrders.has(o.order));
      generateMediaForOutlines(materializedOutlines, stage.id).catch((err) => {
        log.warn('[Classroom] Media generation resume error:', err);
      });
    }
  }, [loading, error, mayGenerate, generateRemaining]);

  const view = resolveClassroomSurfaceView({
    variant,
    loading,
    error,
    notFound,
    loadedClassroomId,
    classroomId,
  });

  return (
    <ThemeProvider>
      <MediaStageProvider value={classroomId}>
        <div
          className={
            variant === 'pane'
              ? // A flex CHILD of the pane's row box, so it has to claim both
                // axes explicitly: `h-full` alone leaves the width to shrink
                // to content, and the classroom chrome (which layers with
                // `absolute inset-0`) then has nothing to fill.
                'flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
              : 'h-screen flex flex-col overflow-hidden'
          }
        >
          {view === 'loading' ? (
            <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin" />
                <p>{t('common.loadingClassroom')}</p>
              </div>
            </div>
          ) : view === 'not-found' ? (
            // Checked BEFORE `error`, and it renders no retry: the sources have
            // all answered, and running the same lookups again cannot change
            // the answer. One message for "deleted" and for "never existed" —
            // see the state's declaration.
            <div
              className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900"
              data-testid="classroom-not-found"
            >
              <div className="flex flex-col items-center gap-3 text-center max-w-md px-6">
                <FileQuestion className="h-10 w-10 text-muted-foreground" />
                <p className="text-lg font-medium">{t('classroom.notFound')}</p>
                <p className="text-sm text-muted-foreground">{t('classroom.notFoundDesc')}</p>
                <Link
                  href="/"
                  className="mt-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                >
                  {t('classroom.backToHome')}
                </Link>
              </div>
            </div>
          ) : view === 'error' ? (
            <div
              className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900"
              data-testid="classroom-load-error"
            >
              <div className="text-center">
                <p className="text-destructive mb-4">
                  {loadUnavailable ? (
                    t('classroom.loadUnavailable')
                  ) : (
                    <>
                      {t('common.errorPrefix')}
                      {error}
                    </>
                  )}
                </p>
                {loadUnavailable ? (
                  <p className="mb-4 text-sm text-muted-foreground">
                    {t('classroom.loadUnavailableDesc')}
                  </p>
                ) : null}
                <button
                  onClick={retryClassroom}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                >
                  {t('common.retry')}
                </button>
              </div>
            </div>
          ) : (
            <Stage
              classroomId={classroomId}
              onRetryOutline={mayGenerate ? retrySingleOutline : undefined}
            />
          )}
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}
