/**
 * Everything that changes a course through its timeline.
 *
 * Human edits are recorded explicitly with {@link commitCourseEdit}: the store is
 * deliberately not subscribed to, so a sync, a generation run or an auto-layout
 * pass can never become a step. Agent edits are recorded where the sync applies
 * them. Undo and redo go through one store action and the normal autosave.
 */

import { setAudioIdById } from '@/components/edit/ActionsBar/actions-edit';
import {
  applyTimelineEntry,
  diffCourse,
  documentAssetRefs,
  dropStep,
  expireSteps,
  nextStep,
  noteDocumentRefs,
  pushEntry,
  stampAudioOnLine,
  stepLine,
  useCourseTimeline,
  withRemovedScenesAsLeft,
  type CourseDocument,
  type TimelineDirection,
  type TimelineEntry,
} from '@/lib/edit/course-timeline';
import { keepLocalWhereUnchanged } from '@/lib/edit/scene-echo';
import { withLearnerStateOf } from '@/lib/pbl/v2/runtime/persisted-scene';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';

function readDocument(): CourseDocument {
  const { stage, scenes, currentSceneId } = useStageStore.getState();
  return { stage, scenes, currentSceneId };
}

function noteRefs(stageId: string, document: CourseDocument, now: number): void {
  useCourseTimeline
    .getState()
    .updateLine(stageId, (line) => noteDocumentRefs(line, documentAssetRefs(document), now));
}

function pushStep(stageId: string, before: CourseDocument, entry: TimelineEntry): void {
  trackCourseSwitches();
  const timeline = useCourseTimeline.getState();
  if (!timeline.lines[stageId]?.knownRefs) noteRefs(stageId, before, entry.at);
  timeline.updateLine(stageId, (line) => pushEntry(line, entry));
  noteRefs(stageId, readDocument(), entry.at);
}

let commitDepth = 0;

/**
 * Run a human edit and put what it changed on the timeline as one step. A step
 * with the same `coalesceKey` as the one before it folds into it (a typing
 * burst, a reorder drag). A commit inside a commit belongs to the outer one.
 */
export function commitCourseEdit<T>(
  options: { readonly coalesceKey?: string },
  mutate: () => T,
): T {
  const before = readDocument();
  const stageId = before.stage?.id;
  if (!stageId || commitDepth > 0) return mutate();
  commitDepth += 1;
  let result: T;
  try {
    result = mutate();
  } finally {
    commitDepth -= 1;
  }
  const now = Date.now();
  const entry = diffCourse(before, readDocument(), {
    origin: 'user',
    at: now,
    coalesceKey: options.coalesceKey,
  });
  if (entry) pushStep(stageId, before, entry);
  return result;
}

/**
 * A change that reached the store from outside this browser. One agent run is
 * one step, unless a hand edit or an undo landed in between.
 */
export function recordAgentChange(before: CourseDocument, after: CourseDocument = readDocument()) {
  const stageId = before.stage?.id;
  if (!stageId || after.stage?.id !== stageId) return;
  const now = Date.now();
  const entry = diffCourse(before, after, {
    origin: 'agent',
    at: now,
    runId: useCourseTimeline.getState().activeRunId(now),
  });
  if (entry) pushStep(stageId, before, entry);
}

/**
 * Audio generated from `text` is back. It belongs on the line only if the line still
 * says that: an edit or an undo may have moved on while it was generating. Versions of
 * the line on the timeline with that text get it either way, so a redo finds its clip.
 * Stamping is write-back, not an edit: no step.
 */
export function stampGeneratedAudio(
  sceneId: string,
  actionId: string,
  text: string,
  audioId: string,
): void {
  const store = useStageStore.getState();
  const actions = store.scenes.find((scene) => scene.id === sceneId)?.actions ?? [];
  const live = actions.find((action) => action.id === actionId);
  if (live?.type === 'speech' && live.text === text) {
    store.updateScene(sceneId, { actions: setAudioIdById(actions, actionId, audioId) });
  }
  const stageId = store.stage?.id;
  if (!stageId || !useCourseTimeline.getState().lines[stageId]) return;
  useCourseTimeline
    .getState()
    .updateLine(stageId, (line) => stampAudioOnLine(line, sceneId, actionId, text, audioId));
}

/**
 * Take steps whose media may be about to be reclaimed off the current course.
 * Returns how many left, for the caller's one toast.
 */
export function sweepExpiredCourseSteps(now = Date.now()): number {
  const document = readDocument();
  const stageId = document.stage?.id;
  if (!stageId) return 0;
  const timeline = useCourseTimeline.getState();
  const line = timeline.lines[stageId];
  if (!line || (line.past.length === 0 && line.future.length === 0)) return 0;
  const result = expireSteps(line, documentAssetRefs(document), now);
  if (result.expired.length > 0) timeline.updateLine(stageId, () => result.line);
  return result.expired.length;
}

/** Undo or redo one step. A step that no longer changes anything is skipped. */
export function stepCourseTimeline(direction: TimelineDirection): void {
  const timeline = useCourseTimeline.getState();
  for (;;) {
    const document = readDocument();
    const stageId = document.stage?.id;
    const line = stageId ? useCourseTimeline.getState().lines[stageId] : undefined;
    const step = line ? nextStep(line, direction) : null;
    if (!stageId || !step) return;
    const applied = applyTimelineEntry(document, step, direction);
    if (!applied) {
      timeline.updateLine(stageId, (current) => dropStep(current, step));
      continue;
    }
    const byId = new Map(document.scenes.map((scene) => [scene.id, scene]));
    const scenes = applied.scenes.map((scene) => {
      const current = byId.get(scene.id);
      return current && scene !== current ? withLearnerStateOf(scene, current) : scene;
    });
    useStageStore.getState().applyCourseTimelineStep({ ...applied, scenes });
    const replayed = withRemovedScenesAsLeft(step, direction, document);
    timeline.updateLine(stageId, (current) => stepLine(current, direction, replayed));
    timeline.splitAgentRun();
    noteRefs(stageId, readDocument(), Date.now());
    if (applied.currentSceneId !== document.currentSceneId) {
      const canvas = useCanvasStore.getState();
      canvas.setActiveElementIdList([]);
      canvas.setEditingElementId('');
    }
    return;
  }
}

/**
 * A course coming back after the browser looked away from it may have changed in
 * the meantime. Those changes go on the line, so undoing an older step cannot
 * silently overwrite them.
 */
const departures = new Map<string, { readonly document: CourseDocument; readonly at: number }>();

let trackingCourseSwitches = false;

function trackCourseSwitches(): void {
  if (trackingCourseSwitches) return;
  trackingCourseSwitches = true;
  useStageStore.subscribe((state, previous) => {
    const leaving = previous.stage?.id;
    if (leaving && leaving !== state.stage?.id && previous.scenes.length > 0) {
      const line = useCourseTimeline.getState().lines[leaving];
      if (line && (line.past.length > 0 || line.future.length > 0)) {
        departures.set(leaving, {
          document: {
            stage: previous.stage,
            scenes: previous.scenes,
            currentSceneId: previous.currentSceneId,
          },
          at: Date.now(),
        });
      }
    }
    const arriving = state.stage?.id;
    if (!arriving || state.scenes.length === 0) return;
    const departure = departures.get(arriving);
    if (!departure) return;
    departures.delete(arriving);
    const arrived: CourseDocument = {
      stage: state.stage,
      scenes: state.scenes,
      currentSceneId: state.currentSceneId,
    };
    // Media gone when the course came back may have gone any time while it was away:
    // count from the departure, so the expiry never trusts it longer than it can.
    useCourseTimeline
      .getState()
      .updateLine(arriving, (line) =>
        noteDocumentRefs(line, documentAssetRefs(arrived), departure.at),
      );
    // Compared as the sync compares a read-back: in the form the server holds, with
    // the sizes this browser measures left out.
    recordAgentChange(departure.document, {
      ...arrived,
      scenes: keepLocalWhereUnchanged(departure.document.scenes, state.scenes),
    });
  });
}
