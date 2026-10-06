'use client';

/**
 * ClassroomSurface — the classroom, wherever it is mounted.
 *
 * This is the body `/classroom/[id]` has always had: the load pipeline, the
 * generation run it follows and the `Stage` dispatch under `ThemeProvider` /
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
 * both variants gate the run's Retry on ownership, and the standalone page
 * also applies its viewer-specific edit access.
 */

import { Stage } from '@/components/stage';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { claimStageSceneLoadToken, isCurrentStageSceneLoadToken } from '@/lib/store/stage';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useNarrationAdoption } from '@/lib/audio/use-narration-adoption';
import { createLogger } from '@/lib/logger';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { useI18n } from '@/lib/hooks/use-i18n';
import { FileQuestion, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { defaultClassroomLoadDeps, runClassroomLoad } from '@/lib/classroom/load-classroom';
import {
  paneAvailabilityRetryDelay,
  resolveClassroomSurfaceView,
} from '@/lib/classroom/progressive-load-policy';
import { useClassroomSession } from '@/lib/classroom/use-classroom-session';
import { applySceneDeepLink } from '@/lib/classroom/scene-deep-link';
import { useRunCourse } from '@/lib/generation-run-client/use-run-course';
import { CourseGeneratingPlaceholder } from './CourseGeneratingPlaceholder';

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
  const activeClassroomIdRef = useRef<string | null>(null);
  const loadEpochRef = useRef(0);

  const { mayGenerate, refreshOwnership } = useClassroomSession({ classroomId, variant });

  const loadClassroom = useCallback(
    async (isEffectCurrent: () => boolean): Promise<ClassroomLoadOutcome> => {
      const loadToken = claimStageSceneLoadToken();
      const isCurrent = () => isEffectCurrent() && isCurrentStageSceneLoadToken(loadToken);

      try {
        const loadResult = await runClassroomLoad({
          classroomId,
          loadToken,
          isCurrent,
          loadFromStorage: async (id, token) => {
            await loadFromStorage(id, token);
            // `?scene=<id>` opens the page at that scene (links from exported
            // decks). Applied before the rest of the load so the opening
            // scene's media is the one hydrated first. The pane lives inside
            // the workspace URL, so only the standalone page reads it.
            if (variant === 'page' && isCurrent()) {
              applySceneDeepLink(window.location.search, id, useStageStore);
            }
          },
          getCurrentStage: () => useStageStore.getState().stage,
          loadRestoredMediaTasks: defaultClassroomLoadDeps.loadRestoredMediaTasks,
          applyRestoredMediaTasks: (restored) =>
            defaultClassroomLoadDeps.applyRestoredMediaTasks(restored, isCurrent),
          discardRestoredMediaTasks: defaultClassroomLoadDeps.discardRestoredMediaTasks,
          loadLegacyAgentFallbacks: defaultClassroomLoadDeps.loadLegacyAgentFallbacks,
          commitMigratedAgentConfigs: defaultClassroomLoadDeps.commitMigratedAgentConfigs,
          applyGeneratedAgents: defaultClassroomLoadDeps.applyGeneratedAgents,
          getSettings: () => useSettingsStore.getState(),
          getAgent: (id) => useAgentRegistry.getState().getAgent(id),
          agentsReady: defaultClassroomLoadDeps.agentsReady,
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

    return () => {
      cancelled = true;
      if (loadEpochRef.current === loadEpoch) {
        loadEpochRef.current += 1;
      }
      if (activeClassroomIdRef.current === classroomId) {
        activeClassroomIdRef.current = null;
      }
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [classroomId, loadClassroom, refreshOwnership, variant]);

  // Narration written before this application stored media server-side is a
  // derived key that only this browser can resolve. Both classroom surfaces
  // mount this, so a course opened through the workbench pane converges its
  // narration exactly as the standalone page does.
  useNarrationAdoption(classroomId, { ready: !loading && !error, mayGenerate });

  // A course a server-side generation run produces: the classroom follows the
  // run (its scenes, media and pauses) and sends it Retry.
  const runCourse = useRunCourse({ classroomId, ready: !loading && !error });

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
          ) : variant === 'pane' && runCourse.generation ? (
            // The pane is edit-locked and a course being generated is
            // read-only until its run completes: say so rather than show an
            // edit chrome that cannot resolve. The run completing clears
            // `generation` and the course mounts here by itself.
            <CourseGeneratingPlaceholder
              status={runCourse.generation.status}
              href={runCourse.generation.href}
            />
          ) : (
            <Stage
              classroomId={classroomId}
              onRetryOutline={mayGenerate && runCourse.runId ? runCourse.retryOutline : undefined}
            />
          )}
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}
