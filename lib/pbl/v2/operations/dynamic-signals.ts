/**
 * PBL v2 — Stage 3 (dynamic) signal pipeline.
 *
 * Wraps the bare `ProficiencySignal` builders from `proficiency.ts`
 * into one-line entry points the Instructor calls from inside its
 * tool executes. Each entry point:
 *
 *   1. Builds the appropriate `ProficiencySignal`.
 *   2. Folds it into the project's assessment via
 *      `updateProjectAssessment` (EWMA + retier-gate logic).
 *   3. On a tier transition, appends a `proficiency_changed`
 *      engagement event so the silent audit trail captures the
 *      switch.
 *   4. Returns the SSE patches the caller should yield so the
 *      client's dev badge and engagement ledger stay in sync.
 *
 * Why centralise: keeping the conversion + bookkeeping + SSE
 * emission in one place means the Instructor file only deals with
 * its existing concerns (LLM streaming, tools, force-advance) and
 * one new line per tool — `yield* trackXxx(project, ...)`. It also
 * keeps the algorithm side of things easily unit-testable without
 * mocking the streaming layer.
 *
 * **No UI side-effect by design.** The patches emitted here are only
 * consumed by the dev badge (env-flag gated) and the silent
 * engagement ledger — never the chat. See INTEGRATION-PLAN §9 for
 * the rationale.
 */

import { microtaskEngagement, recordEvent } from './engagement';
import {
  ensureAssessment,
  explicitAssessment,
  signalFromClosingCheck,
  signalFromForceAdvance,
  signalFromObservation,
  signalFromSubmissionScore,
  signalFromTaskSpeed,
  stepProficiency,
  updateProjectAssessment,
  type ProficiencyDirective,
} from './proficiency';
import { appendProficiencyUpdatedRuntimeEvent } from './runtime-events';
import type { PBLProjectV2, ProficiencyTransition } from '../types';
import type { PBLSSEEvent } from '../api/sse';

/** Did a transition fire on the last signal? Used by callers that
 *  need to render the transition history outside the SSE channel
 *  (e.g. the future evaluator). */
export interface DynamicSignalResult {
  transition?: ProficiencyTransition;
  patches: PBLSSEEvent[];
}

/** Append the engagement event and build the SSE patches for a
 *  signal-driven update. Pure-ish: mutates `project` via the
 *  engagement ledger (matches the rest of the operations module). */
function emit(project: PBLProjectV2, transition?: ProficiencyTransition): DynamicSignalResult {
  const patches: PBLSSEEvent[] = [];
  if (transition) {
    const evt = recordEvent(project, 'proficiency_changed', {
      payload: {
        from: transition.from,
        to: transition.to,
        reason: transition.reason,
        score: project.proficiencyAssessment?.score,
        confidence: project.proficiencyAssessment?.confidence,
      },
    });
    patches.push({
      type: 'project_patch',
      patch: {
        kind: 'engagement_event',
        event: evt,
        eventKind: 'proficiency_changed',
        microtaskId: evt.microtaskId,
        milestoneId: evt.milestoneId,
        ts: evt.ts,
        payload: evt.payload,
      },
    });
  }
  if (project.proficiencyAssessment) {
    patches.push({
      type: 'project_patch',
      patch: {
        kind: 'proficiency',
        assessment: project.proficiencyAssessment,
        tierChanged: !!transition,
      },
    });
  }
  return { transition, patches };
}

/** Convert an Instructor `record_observation` tool call into a
 *  proficiency signal. Caller should pass `repeat` when the same
 *  error signature has been seen in the same microtask before — the
 *  engagement ledger has `repeatErrorCount` cached on completion. */
export function trackObservation(
  project: PBLProjectV2,
  kind: 'error' | 'concept_unlocked' | 'struggle' | 'question',
  opts: { repeat?: boolean; note?: string } = {},
): DynamicSignalResult {
  const signal = signalFromObservation(kind, opts);
  const { transition } = updateProjectAssessment(project, signal);
  return emit(project, transition);
}

/** Convert an Instructor `record_closing_check` tool call into a
 *  proficiency signal. */
export function trackClosingCheck(
  project: PBLProjectV2,
  quality: 'weak' | 'ok' | 'strong',
): DynamicSignalResult {
  const signal = signalFromClosingCheck(quality);
  const { transition } = updateProjectAssessment(project, signal);
  return emit(project, transition);
}

/** Convert a force-advance trigger into a proficiency signal. */
export function trackForceAdvance(project: PBLProjectV2): DynamicSignalResult {
  const signal = signalFromForceAdvance();
  const { transition } = updateProjectAssessment(project, signal);
  return emit(project, transition);
}

/** Convert a microtask completion into a task-speed signal, derived
 *  from the engagement ledger's `learnerTurnCount` for that
 *  microtask. No-op on extremely short/medium ranges where the
 *  speed has no clear directional reading. */
export function trackMicrotaskCompletion(
  project: PBLProjectV2,
  microtaskId: string,
): DynamicSignalResult {
  const summary = microtaskEngagement(project, microtaskId);
  const signal = signalFromTaskSpeed(summary.learnerTurnCount ?? 0);
  if (!signal) {
    // Neutral middle band; still emit a snapshot of the unchanged
    // assessment so the dev badge stays current after every
    // microtask completion (caller decides whether to forward).
    if (!project.proficiencyAssessment) return { patches: [] };
    return {
      patches: [
        {
          type: 'project_patch',
          patch: {
            kind: 'proficiency',
            assessment: project.proficiencyAssessment,
            tierChanged: false,
          },
        },
      ],
    };
  }
  const { transition } = updateProjectAssessment(project, signal);
  return emit(project, transition);
}

/** Convert a submission score into a proficiency signal. Used by the
 *  evaluator path (PR 6); included here so the wiring is in one
 *  place. */
export function trackSubmissionScore(project: PBLProjectV2, score: number): DynamicSignalResult {
  const signal = signalFromSubmissionScore(score);
  if (!signal) return { patches: [] };
  const { transition } = updateProjectAssessment(project, signal);
  return emit(project, transition);
}

/**
 * Apply an already-resolved difficulty directive, bypassing the dynamic retier
 * gates (highest priority). The directive comes from the Instructor's
 * `adjust_difficulty` tool: the LLM judges — from the learner's message, in any
 * language — whether they asked to change difficulty / stated their own level,
 * and a learner telling us what they want is treated as ground truth (set the
 * tier directly, immediately, bypassing every gate). No-op (no patches) when
 * the directive resolves to the learner's current tier.
 *
 * Performance signals can still adapt the tier later (the override resets the
 * retier counters, so it also wins over any same-turn dynamic signal during the
 * cooldown window) — exactly like an initial self-report.
 *
 * Same-tier directive (target == current): NOT a no-op. The learner still
 * explicitly stated their level, so we anchor it — lock confidence to 1, mark
 * the source as self-report and reset the cooldown counters — WITHOUT
 * fabricating a "tier changed" transition or engagement event. Skipping this
 * (the old behaviour) let the explicit declaration be silently overwritten by a
 * couple of subsequent dynamic signals, which is exactly the drift the learner
 * was trying to prevent.
 */
export function applyProficiencyDirective(
  project: PBLProjectV2,
  directive: ProficiencyDirective,
): DynamicSignalResult {
  const current = ensureAssessment(project);
  const target =
    directive.kind === 'absolute'
      ? directive.tier
      : stepProficiency(current.tier, directive.direction);

  const next = explicitAssessment(target, 'self-report');
  if (current.tier === target) {
    // Anchor in place: keep the existing transition history, emit only the
    // proficiency patch (tierChanged:false) so the dev badge / state stay in
    // sync. No transition → no proficiency_changed event.
    project.proficiencyAssessment = { ...next, transitions: current.transitions };
    project.proficiency = target;
    appendProficiencyUpdatedRuntimeEvent(project);
    project.updatedAt = next.lastUpdatedAt;
    return emit(project);
  }

  const transition: ProficiencyTransition = {
    from: current.tier,
    to: target,
    ts: next.lastUpdatedAt,
    reason: directive.kind === 'absolute' ? 'learner self-report' : 'learner difficulty request',
  };
  project.proficiencyAssessment = { ...next, transitions: [...current.transitions, transition] };
  project.proficiency = target;
  appendProficiencyUpdatedRuntimeEvent(project);
  project.updatedAt = next.lastUpdatedAt;
  return emit(project, transition);
}

/** Increment the assessment's `turnsSinceRetier` counter at the
 *  start of every learner-driven turn so the cooldown gate has
 *  fresh data. Called once per Instructor turn from the route
 *  handler / runInstructorTurn. */
export function tickTurnOnProject(project: PBLProjectV2): void {
  if (!project.proficiencyAssessment) return;
  project.proficiencyAssessment = {
    ...project.proficiencyAssessment,
    turnsSinceRetier: project.proficiencyAssessment.turnsSinceRetier + 1,
  };
}
