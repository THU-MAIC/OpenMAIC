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
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { PENDING_SCENE_ID, setServerGeneratingStage, useStageStore } from '@/lib/store/stage';
import { fetchScenesByIds, fetchStageManifest } from '@/lib/workbench/stage-freshness';
import { createLogger } from '@/lib/logger';
import { getClientTranslation } from '@/lib/i18n';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

import { RunApiError } from './api';
import { retryPausedRun, retryRunMedia } from './commands';
import { applyRunMedia, registerRunMediaRetry } from './run-media';
import { isFinishedRunState, type RunView } from './types';
import { useGenerationRun } from './use-generation-run';

const log = createLogger('RunCourse');

const RUN_ID = /^run-[A-Za-z0-9_-]{16}$/;

/** The run producing a course, from its document's producer fields. */
export function runIdOfCourse(producer: string | null, producerRef: string | null): string | null {
  return producer === 'server-job' && producerRef && RUN_ID.test(producerRef) ? producerRef : null;
}

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

/** Merge scenes read from the server into the store's, by id, in order; no save is queued. */
function applyServerScenes(scenes: readonly Scene[]): void {
  if (scenes.length === 0) return;
  const state = useStageStore.getState();
  const stageId = state.stage?.id;
  const fresh = scenes.filter((scene) => scene.stageId === stageId);
  if (fresh.length === 0) return;
  const byId = new Map(state.scenes.map((scene) => [scene.id, scene]));
  for (const scene of fresh) byId.set(scene.id, scene);
  const merged = [...byId.values()].sort((a, b) => a.order - b.order);
  const orders = new Set(merged.map((scene) => scene.order));
  useStageStore.setState({
    scenes: merged,
    generatingOutlines: state.generationComplete
      ? []
      : state.outlines.filter((outline) => !orders.has(outline.order)),
    currentSceneId:
      state.currentSceneId && state.currentSceneId !== PENDING_SCENE_ID
        ? state.currentSceneId
        : (merged[0]?.id ?? null),
  });
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
  const viewRef = useRef<RunView | null>(null);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // While the run is not over, the course is read-only.
  const active = !!view && !isFinishedRunState(view.state);
  useEffect(() => {
    if (!runId) return;
    setServerGeneratingStage(active ? input.classroomId : null);
    useStageStore.setState({ courseGenerating: active });
    return () => {
      setServerGeneratingStage(null);
      useStageStore.setState({ courseGenerating: false });
    };
  }, [runId, active, input.classroomId]);

  // A run that is unknown (its log was compacted after it finished) leaves the course as loaded.
  useEffect(() => {
    if (status === 'missing' && runId) log.info(`Run ${runId} of this course is no longer kept`);
  }, [status, runId]);

  // Read the scenes the run appended (or changed) since this classroom read the course.
  const syncing = useRef<Promise<void> | null>(null);
  const resyncWanted = useRef(false);
  const changedScenes = useRef(new Set<string>());
  const syncScenes = useCallback(async (): Promise<void> => {
    if (syncing.current) {
      resyncWanted.current = true;
      return syncing.current;
    }
    const stageId = input.classroomId;
    syncing.current = (async () => {
      do {
        resyncWanted.current = false;
        const manifest = await fetchStageManifest(stageId);
        if (manifest.status !== 'ok') return;
        const known = new Set(useStageStore.getState().scenes.map((scene) => scene.id));
        const wanted = new Set(changedScenes.current);
        changedScenes.current.clear();
        for (const scene of manifest.manifest.scenes)
          if (!known.has(scene.id)) wanted.add(scene.id);
        if (wanted.size === 0) continue;
        const scenes = await fetchScenesByIds(stageId, [...wanted]);
        if (useStageStore.getState().stage?.id !== stageId) return;
        applyServerScenes(scenes);
      } while (resyncWanted.current);
    })()
      .catch((error) => log.warn('Reading the generated scenes failed:', error))
      .finally(() => {
        syncing.current = null;
      });
    return syncing.current;
  }, [input.classroomId]);

  const following = !!view;
  const scenesCompleted = view?.progress.scenesCompleted ?? 0;
  const scenesReported = view ? Object.keys(view.readyScenes).length : 0;
  useEffect(() => {
    if (following) void syncScenes();
  }, [following, scenesCompleted, scenesReported, syncScenes]);

  // A placed image or video rewrote its scene; completion may have too.
  const lastMedia = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!view) return;
    let changed = false;
    for (const [elementId, state] of Object.entries(view.media)) {
      if (state.status === 'done' && lastMedia.current[elementId] !== state.assetId) {
        lastMedia.current[elementId] = state.assetId ?? '';
        const sceneId = sceneHoldingElement(elementId);
        if (sceneId) {
          changedScenes.current.add(sceneId);
          changed = true;
        }
      }
    }
    applyRunMedia(input.classroomId, view.media);
    if (changed) void syncScenes();
  }, [view?.media, input.classroomId, syncScenes]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (completed) {
      // The run's last writes: read every scene once more.
      for (const scene of store.scenes) changedScenes.current.add(scene.id);
      void syncScenes();
    }
  }, [view?.state, view?.error, view?.skippedScenes, view?.outline, syncScenes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Media Retry is the run's command while this classroom follows the run.
  useEffect(() => {
    if (!runId) return;
    return registerRunMediaRetry(input.classroomId, async (elementId) => {
      const current = viewRef.current;
      if (!current) throw new Error('The generation run is not loaded');
      await retryRunMedia(current, elementId);
      // A finished run's stream is closed: follow it again for the retry.
      await refresh();
    });
  }, [runId, input.classroomId, refresh]);

  const retryOutline = useCallback(async (outlineId: string) => {
    const current = viewRef.current;
    if (!current || current.state !== 'paused') return;
    const outlines = current.outline?.outlines ?? useStageStore.getState().outlines;
    if (!failedOutlinesOfRun(current, outlines).some((outline) => outline.id === outlineId)) return;
    try {
      await retryPausedRun(current);
      // Queued until the run picks it up (after a media item in flight).
      useStageStore.setState({ failedOutlines: [], generationStatus: 'generating' });
    } catch (error) {
      log.warn('Retrying the run failed:', error);
      // A paused run does not count against the limit on active runs; its
      // Retry makes it count again.
      if (error instanceof RunApiError && error.errorCode === 'ACTIVE_RUN_LIMIT') {
        toast.error(getClientTranslation('generation.activeRunLimit'));
      }
    }
  }, []);

  return { runId: view ? runId : null, retryOutline };
}
