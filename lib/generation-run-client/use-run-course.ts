'use client';

/**
 * The classroom of a course a generation run is producing.
 *
 * The run appends each scene to the course document as it is ready and
 * places each image and video as it is stored; the classroom follows the
 * run's events, reads the scenes it appended, and renders the run's state the
 * way classic generation rendered its own: the next scene's placeholder while
 * generating, the failed scene with Retry when the run paused, each media
 * element's skeleton, failure (with Retry) or disabled placeholder. Until the
 * run completes the course is read-only here: the server refuses every other
 * writer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { hasLearnerSceneChange, setServerGeneratingStage, useStageStore } from '@/lib/store/stage';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import { fetchScenesByIds, fetchStageManifest } from '@/lib/workbench/stage-freshness';
import { createLogger } from '@/lib/logger';
import { getClientTranslation } from '@/lib/i18n';
import type { SceneOutline } from '@/lib/types/generation';

import { RunApiError } from './api';
import { retryPausedRun, retryRunMedia } from './commands';
import { applyRunMedia, registerRunMediaRetry } from './run-media';
import { courseFenced, mergeServerScenes, RunCourseSceneSync } from './run-course';
import { isFinishedRunState, type RunView } from './types';
import { useGenerationRun } from './use-generation-run';
import { runIdOfCourse } from './run-id';

const log = createLogger('RunCourse');

export { runIdOfCourse } from './run-id';

/** The scene index a step id names. */
function sceneIndexOfStep(step: string | null | undefined): number | null {
  const match = step ? /^scene:(\d+):/.exec(step) : null;
  return match ? Number(match[1]) : null;
}

/** The outlines a paused run failed at: the step it stopped at and the scenes it went on past. */
export function failedOutlinesOfRun(
  view: RunView,
  outlines: readonly SceneOutline[],
): SceneOutline[] {
  if (view.state !== 'paused') return [];
  const indices = new Set(Object.keys(view.skippedScenes).map(Number));
  const stopped = sceneIndexOfStep(view.error?.step);
  if (stopped !== null) indices.add(stopped);
  return [...indices]
    .sort((a, b) => a - b)
    .flatMap((index) => (outlines[index] ? [outlines[index]!] : []));
}

/** The classroom's generation status for a run state. */
export function generationStatusOfRun(
  state: RunView['state'],
): 'generating' | 'paused' | 'completed' | 'idle' {
  if (state === 'paused') return 'paused';
  if (state === 'completed') return 'completed';
  if (state === 'ended') return 'idle';
  return 'generating';
}

/** The scene of the store that holds a media element (by its placeholder). */
function sceneHoldingElement(elementId: string): string | null {
  for (const scene of useStageStore.getState().scenes) {
    if (JSON.stringify(scene.content).includes(`"${elementId}"`)) return scene.id;
  }
  return null;
}

export function useRunCourse(input: { classroomId: string; ready: boolean }): {
  /** The run producing this course, while the classroom follows it. */
  runId: string | null;
  /** Retry the failed scene of a paused run. */
  retryOutline: (outlineId: string) => Promise<void>;
} {
  const producer = useStageStore((s) => s.outlineProducer);
  const producerRef = useStageStore((s) => s.outlineProducerRef);
  const loadedId = useStageStore((s) => s.stage?.id ?? null);
  const runId =
    input.ready && loadedId === input.classroomId ? runIdOfCourse(producer, producerRef) : null;
  const { view, status, refresh } = useGenerationRun(runId);
  const capabilities = useModelCapabilities();
  const viewRef = useRef<RunView | null>(null);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // The scene reads, for this course while it follows a run.
  const [sync, setSync] = useState<RunCourseSceneSync | null>(null);
  useEffect(() => {
    if (!runId) return;
    const stageId = input.classroomId;
    const created = new RunCourseSceneSync(stageId, {
      fetchManifest: fetchStageManifest,
      fetchScenes: fetchScenesByIds,
      knownSceneIds: () => useStageStore.getState().scenes.map((scene) => scene.id),
      apply: (scenes) => {
        const state = useStageStore.getState();
        if (state.stage?.id !== stageId) return;
        // A PBL scene the classroom holds carries the learner's progress
        // (the run never changes it after appending it): it is kept.
        const pblScenes = new Set(
          state.scenes.filter((scene) => scene.content.type === 'pbl').map((scene) => scene.id),
        );
        const patch = mergeServerScenes(
          state,
          scenes,
          stageId,
          (sceneId) => pblScenes.has(sceneId) || hasLearnerSceneChange(stageId, sceneId),
        );
        if (patch) useStageStore.setState(patch);
      },
      onWarn: (message, error) => log.warn(`${message}:`, error),
    });
    setSync(created);
    return () => {
      created.close();
      setSync(null);
    };
  }, [runId, input.classroomId]);

  // The course is read-only while its run is not over, or not known to be; a
  // finished run lifts it once the classroom holds the run's last writes. The
  // document was loaded before the run was read, so even a run that was over
  // when the classroom opened is read once more first.
  const [reconciled, setReconciled] = useState(false);
  const finished = !!view && isFinishedRunState(view.state);
  useEffect(() => {
    if (!finished || reconciled || !sync) return;
    let cancelled = false;
    void sync.reconcile().then(() => {
      if (!cancelled) setReconciled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [finished, reconciled, sync]);

  const fenced = courseFenced({ runId, status, view, reconciled });
  useEffect(() => {
    if (!runId) return;
    setServerGeneratingStage(fenced ? input.classroomId : null);
    useStageStore.setState({ courseGenerating: fenced });
    return () => {
      setServerGeneratingStage(null);
      useStageStore.setState({ courseGenerating: false });
    };
  }, [runId, fenced, input.classroomId]);

  // A run that is unknown (its log was compacted after it finished) leaves the course as loaded.
  useEffect(() => {
    if (status === 'missing' && runId) log.info(`Run ${runId} of this course is no longer kept`);
  }, [status, runId]);

  // Scenes appended since this classroom read the course.
  const scenesCompleted = view?.progress.scenesCompleted ?? 0;
  const scenesReported = view ? Object.keys(view.readyScenes).length : 0;
  useEffect(() => {
    if (sync && view) void sync.sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on progress, not every event
  }, [sync, !!view, scenesCompleted, scenesReported]);

  // Media: the run's states in the media store; a placed image or video
  // rewrote its scene, which is read again.
  const slots = { image: !!capabilities.image, video: !!capabilities.video };
  const lastMedia = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!view) return;
    const changed: string[] = [];
    for (const [elementId, state] of Object.entries(view.media)) {
      if (state.status === 'done' && lastMedia.current[elementId] !== state.assetId) {
        lastMedia.current[elementId] = state.assetId ?? '';
        const sceneId = sceneHoldingElement(elementId);
        if (sceneId) changed.push(sceneId);
      }
    }
    applyRunMedia(input.classroomId, view.media, slots);
    if (changed.length > 0 && sync) {
      sync.markChanged(changed);
      void sync.sync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slots is derived each render
  }, [view?.media, input.classroomId, sync, slots.image, slots.video]);

  // The run's state as the classroom's generation state.
  useEffect(() => {
    if (!view) return;
    const store = useStageStore.getState();
    const outlines = view.outline?.outlines ?? store.outlines;
    const completed = view.state === 'completed';
    useStageStore.setState({
      generationStatus: generationStatusOfRun(view.state),
      failedOutlines: failedOutlinesOfRun(view, outlines),
      ...(completed ? { generationComplete: true, generatingOutlines: [] } : {}),
    });
  }, [view?.state, view?.error, view?.skippedScenes, view?.outline]); // eslint-disable-line react-hooks/exhaustive-deps

  // Media Retry is the run's command while this classroom follows the run.
  useEffect(() => {
    if (!runId) return;
    return registerRunMediaRetry(input.classroomId, async (elementId) => {
      const current = viewRef.current;
      if (!current) throw new Error('The generation run is not loaded');
      await retryRunMedia(current, elementId);
      // Follow the run again for the retried item.
      await refresh();
    });
  }, [runId, input.classroomId, refresh]);

  const retryOutline = useCallback(
    async (outlineId: string) => {
      const current = viewRef.current;
      if (!current || current.state !== 'paused') return;
      const outlines = current.outline?.outlines ?? useStageStore.getState().outlines;
      if (!failedOutlinesOfRun(current, outlines).some((outline) => outline.id === outlineId)) {
        return;
      }
      try {
        await retryPausedRun(current);
        // Queued until the run picks it up (after a media item in flight).
        useStageStore.setState({ failedOutlines: [], generationStatus: 'generating' });
      } catch (error) {
        log.warn('Retrying the run failed:', error);
        if (error instanceof RunApiError && error.errorCode === 'ACTIVE_RUN_LIMIT') {
          // A paused run does not count against the limit; its Retry does.
          toast.error(getClientTranslation('generation.activeRunLimit'));
        } else if (error instanceof RunApiError && error.errorCode === 'RUN_STATE_CONFLICT') {
          toast.info(getClientTranslation('generation.runChangedElsewhere'));
        }
      }
      await refresh();
    },
    [refresh],
  );

  return { runId: view ? runId : null, retryOutline };
}
