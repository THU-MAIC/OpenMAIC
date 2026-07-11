/**
 * PBL v2 — Pre-PBL quiz snapshot helpers.
 *
 * The adaptive proficiency engine's Stage 2 (`source: 'pre-play'`)
 * recalibration consumes the learner's prior-quiz results so the
 * Instructor starts with a more accurate proficiency tier than the
 * Planner-time static signals alone could produce.
 *
 * Quiz results live in the browser's `localStorage`, written by
 * `lib/quiz/persistence.ts` when the learner submits a quiz. That
 * persistence layer is purely client-side, so the snapshot is built
 * on the client (in `hero.tsx` right before the GREETING request
 * fires) and **piggybacked** on the existing `/api/pbl/v2/open-task`
 * POST body as `priorQuizResults?: PriorQuizResult[]`. This avoids
 * introducing a new endpoint just for recalibration.
 *
 * Two pure helpers live here:
 *   - `buildQuizSnapshot(scenes)` — client-side, reads localStorage
 *      for each prior quiz scene and returns the aggregated
 *      `PriorQuizResult[]`. Safe to call in SSR (returns []).
 *   - `applyQuizSignalsToProject(project, results)` — server-side,
 *      folds the snapshot into `project.proficiencyAssessment`. Used
 *      by the `/api/pbl/v2/open-task` route handler.
 */

import { readSubmittedState } from '@/lib/quiz/persistence';
import type { Scene } from '@/lib/types/stage';
import { applyQuizSnapshot, ensureAssessment } from './proficiency';
import { appendProficiencyUpdatedRuntimeEvent } from './runtime-events';
import type { PBLProjectV2, PriorQuizResult } from '../types';

/** Build a `PriorQuizResult[]` from the scenes preceding the PBL
 *  scene. Reads `localStorage` via the quiz persistence module.
 *
 *  - SSR-safe: returns `[]` when `localStorage` is unavailable
 *    (`readSubmittedState` is internally SSR-guarded).
 *  - Only scenes the learner has actually submitted contribute;
 *    drafts (`kind === 'answering'`) and never-opened quizzes do
 *    not move the signal.
 *  - Short-answer questions without `hasAnswer` are counted as
 *    `unscoredCount` rather than wrong — the engine excludes them
 *    from the accuracy denominator. */
export function buildQuizSnapshot(scenesBeforePbl: Scene[]): PriorQuizResult[] {
  const out: PriorQuizResult[] = [];
  for (const scene of scenesBeforePbl) {
    if (scene.type !== 'quiz' || scene.content.type !== 'quiz') continue;
    const state = readSubmittedState(scene.id);
    if (!state || state.kind !== 'reviewing') continue;
    // `reviewing` means the learner has submitted AND seen the
    // graded results — that's the only case where we have a
    // trustworthy correctness signal.
    const questions = scene.content.questions ?? [];
    if (questions.length === 0) continue;

    let correct = 0;
    let incorrect = 0;
    let unscored = 0;
    for (const r of state.results) {
      // `correct === null` for short-answer / non-auto-gradable
      // questions: count as unscored, do not penalise.
      if (r.correct === null) {
        unscored++;
      } else if (r.correct) {
        correct++;
      } else {
        incorrect++;
      }
    }
    const scored = correct + incorrect;
    const accuracy = scored === 0 ? null : correct / scored;
    out.push({
      sceneId: scene.id,
      sceneTitle: scene.title,
      totalQuestions: questions.length,
      correctCount: correct,
      incorrectCount: incorrect,
      unscoredCount: unscored,
      accuracy,
    });
  }
  return out;
}

/** Server-side entry point: apply a freshly built quiz snapshot to
 *  the project's proficiency assessment. Mutates the assessment in
 *  place (and `project.proficiency` if the tier changes); returns
 *  the assessment after the update for caller logging. No-op when
 *  the snapshot is empty or no question was auto-graded. */
export function applyQuizSignalsToProject(
  project: PBLProjectV2,
  results: PriorQuizResult[],
): { updated: boolean; tierChanged: boolean } {
  if (!results || results.length === 0) {
    return { updated: false, tierChanged: false };
  }
  const before = ensureAssessment(project);
  const next = applyQuizSnapshot(before, results);
  if (next === before) {
    // applyQuizSnapshot returns the same reference when no scored
    // questions were present.
    return { updated: false, tierChanged: false };
  }
  project.proficiencyAssessment = next;
  const tierChanged = next.tier !== before.tier;
  if (tierChanged) {
    project.proficiency = next.tier;
  }
  appendProficiencyUpdatedRuntimeEvent(project);
  project.updatedAt = next.lastUpdatedAt;
  return { updated: true, tierChanged };
}
