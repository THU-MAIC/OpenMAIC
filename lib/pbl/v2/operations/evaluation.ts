/**
 * PBL v2 — Evaluation helpers.
 *
 * Evaluation records produced by `record_closing_check` (task-level)
 * and by the standalone evaluator runs (milestone / final, PR 6 / 7).
 * PR 3 only needs the helper to write a task-level evaluation when
 * `advance_micro_task` is called; richer evaluations come in
 * later PRs.
 */

import type { PBLEvaluation, PBLEvaluationKind, PBLProjectV2, PBLScenarioActGoals } from '../types';

function newId(prefix: string): string {
  return (
    prefix + '_' + Math.random().toString(16).slice(2, 8) + Math.random().toString(16).slice(2, 8)
  );
}

export function addEvaluation(
  project: PBLProjectV2,
  args: {
    kind: PBLEvaluationKind;
    microtaskId?: string;
    milestoneId?: string;
    feedback: string;
    strengths?: string[];
    improvements?: string[];
    score?: number;
    stars?: number;
    whatYouBuilt?: string[];
    whatYouLearned?: string[];
    whatsNext?: string;
    actGoals?: PBLScenarioActGoals[];
  },
): PBLEvaluation {
  const evaluation: PBLEvaluation = {
    id: newId('eval'),
    kind: args.kind,
    microtaskId: args.microtaskId,
    milestoneId: args.milestoneId,
    feedback: args.feedback,
    strengths: args.strengths ?? [],
    improvements: args.improvements ?? [],
    score: args.score,
    stars: args.stars,
    whatYouBuilt: args.whatYouBuilt,
    whatYouLearned: args.whatYouLearned,
    whatsNext: args.whatsNext,
    actGoals: args.actGoals,
    createdAt: new Date().toISOString(),
  };
  project.evaluations.push(evaluation);
  project.updatedAt = evaluation.createdAt;
  return evaluation;
}

export function listEvaluationsForMicrotask(
  project: PBLProjectV2,
  microtaskId: string,
): PBLEvaluation[] {
  return project.evaluations.filter((e) => e.microtaskId === microtaskId);
}

export function listEvaluationsForMilestone(
  project: PBLProjectV2,
  milestoneId: string,
): PBLEvaluation[] {
  return project.evaluations.filter((e) => e.milestoneId === milestoneId);
}
