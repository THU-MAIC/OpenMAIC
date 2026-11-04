/**
 * Everything that changes a course through its timeline.
 *
 * Human edits are recorded explicitly with {@link commitCourseEdit}: the store is
 * deliberately not subscribed to, so a sync, a generation run or an auto-layout
 * pass can never become a step. Agent edits are recorded where the sync applies
 * them. Undo and redo go through one store action and the normal autosave.
 */

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
  type CourseDocument,
  type TimelineDirection,
  type TimelineEntry,
} from '@/lib/edit/course-timeline';
import { sanitizeSceneContent } from '@/lib/sanitize/scene-content';
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

/** Generated audio landed on a speech line: the line's recorded versions get it too. */
export function stampAudioOnTimeline(
  sceneId: string,
  actionId: string,
  text: string,
  audioId: string,
): void {
  const stageId = useStageStore.getState().stage?.id;
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
    useStageStore.getState().applyCourseTimelineStep(applied);
    timeline.updateLine(stageId, (current) => stepLine(current, direction));
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
const departures = new Map<string, CourseDocument>();

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
          stage: previous.stage,
          scenes: previous.scenes,
          currentSceneId: previous.currentSceneId,
        });
      }
    }
    const arriving = state.stage?.id;
    if (!arriving || state.scenes.length === 0) return;
    const departure = departures.get(arriving);
    if (!departure) return;
    departures.delete(arriving);
    // Compared in the form the server holds: what came back was sanitized.
    const left = { ...departure, scenes: sanitizeSceneContent(departure.scenes) };
    recordAgentChange(left, {
      stage: state.stage,
      scenes: state.scenes,
      currentSceneId: state.currentSceneId,
    });
  });
}
