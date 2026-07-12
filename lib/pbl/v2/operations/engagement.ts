/**
 * PBL v2 — Engagement event ledger helpers.
 *
 * The Instructor records small "signals" during a microtask
 * (learner_turn, observation_*, closing_check, microtask_opened,
 * microtask_completed, microtask_skipped). Each signal is appended
 * as a `PBLEngagementEvent` to `PBLProjectV2.engagementEvents`. The
 * full ledger is the source of truth for the per-microtask summary
 * cached on `PBLMicrotask.engagement` and for the evaluator prompt.
 *
 * To prevent `scene.content` from growing unbounded over a long
 * session, the array is kept under a soft cap (`MAX_EVENTS`) by
 * dropping the oldest events first. Cached per-microtask summaries
 * preserve information that would otherwise be lost when older
 * events fall off.
 */

import type {
  PBLEngagementEvent,
  PBLEngagementEventKind,
  PBLEngagementSummary,
  PBLProjectV2,
} from '../types';

/** Soft cap on the engagement ledger size. Older events are dropped
 *  first; per-microtask summaries cache what's lost. Conservatively
 *  sized for IndexedDB / PG JSONB friendliness. */
export const MAX_ENGAGEMENT_EVENTS = 500;

function newId(prefix: string): string {
  return (
    prefix + '_' + Math.random().toString(16).slice(2, 8) + Math.random().toString(16).slice(2, 8)
  );
}

/** Append a single engagement event, capping array size. */
export function recordEvent(
  project: PBLProjectV2,
  kind: PBLEngagementEventKind,
  options: {
    microtaskId?: string;
    milestoneId?: string;
    payload?: Record<string, unknown>;
  } = {},
): PBLEngagementEvent {
  const event: PBLEngagementEvent = {
    id: newId('evt'),
    kind,
    microtaskId: options.microtaskId,
    milestoneId: options.milestoneId,
    ts: new Date().toISOString(),
    payload: options.payload,
  };
  project.engagementEvents.push(event);
  capEngagementEvents(project);
  project.updatedAt = event.ts;
  return event;
}

export function capEngagementEvents(project: PBLProjectV2): void {
  if (project.engagementEvents.length > MAX_ENGAGEMENT_EVENTS) {
    project.engagementEvents.splice(0, project.engagementEvents.length - MAX_ENGAGEMENT_EVENTS);
  }
}

/** Read engagement signals for one microtask out of the ledger. */
export function microtaskEngagement(
  project: PBLProjectV2,
  microtaskId: string,
): PBLEngagementSummary {
  const events = project.engagementEvents.filter((e) => e.microtaskId === microtaskId);
  const summary: PBLEngagementSummary = {};

  let learnerTurnCount = 0;
  let errorCount = 0;
  let questionsRaised = 0;
  const errorSignatures: string[] = [];
  const conceptsUnlocked: string[] = [];
  const conceptUnlockLabels: Record<string, string> = {};
  const struggles: string[] = [];

  for (const e of events) {
    switch (e.kind) {
      case 'microtask_opened':
        summary.startedAt = e.ts;
        break;
      case 'microtask_completed':
      case 'microtask_skipped':
        summary.completedAt = e.ts;
        break;
      case 'learner_turn': {
        learnerTurnCount++;
        break;
      }
      case 'observation_error': {
        errorCount++;
        const sig = String(e.payload?.signature ?? '');
        if (sig) errorSignatures.push(sig);
        break;
      }
      case 'observation_concept_unlocked': {
        const sig = String(e.payload?.signature ?? '');
        if (sig) {
          conceptsUnlocked.push(sig);
          const label = String(e.payload?.label ?? '').trim();
          if (label && !(sig in conceptUnlockLabels)) conceptUnlockLabels[sig] = label;
        }
        break;
      }
      case 'observation_struggle': {
        const sig = String(e.payload?.signature ?? '');
        if (sig) struggles.push(sig);
        break;
      }
      case 'observation_question':
        questionsRaised++;
        break;
      case 'closing_check':
      // A stage-synthesis check is recorded against the last microtask
      // of a `synthesisCheck` stage as well as the milestone. Treating
      // it like a closing check here means it clears this microtask's
      // evidence gate (absorption — no separate microtask reverse-Q is
      // needed) and reaches the evaluator the same way.
      case 'stage_synthesis_check':
        summary.closingQuestion = String(e.payload?.question ?? '');
        summary.closingAnswer = String(e.payload?.learner_answer ?? '');
        summary.closingQuality = e.payload?.quality as PBLEngagementSummary['closingQuality'];
        break;
    }
  }

  if (summary.startedAt && summary.completedAt) {
    summary.durationSeconds = Math.max(
      0,
      Math.round(
        (new Date(summary.completedAt).getTime() - new Date(summary.startedAt).getTime()) / 1000,
      ),
    );
  }

  summary.learnerTurnCount = learnerTurnCount;
  summary.errorCount = errorCount;
  summary.repeatErrorCount = errorSignatures.length - new Set(errorSignatures).size;
  summary.errorSignatures = Array.from(new Set(errorSignatures));
  summary.conceptsUnlocked = Array.from(new Set(conceptsUnlocked));
  if (Object.keys(conceptUnlockLabels).length > 0) {
    summary.conceptUnlockLabels = conceptUnlockLabels;
  }
  summary.struggles = Array.from(new Set(struggles));
  summary.questionsRaised = questionsRaised;

  return summary;
}

/** True once the stage-level integrative checkpoint is on record for
 *  this milestone. The milestone seal gate uses this to refuse
 *  completing a `synthesisCheck` stage until the integrative
 *  reverse-question (or the escape-hatch capture of a spontaneous
 *  articulation) has landed. Deterministic — not a prompt hope.
 *
 *  Satisfied by EITHER:
 *   - a dedicated `stage_synthesis_check` anywhere in the milestone
 *     (the intended path), OR
 *   - a plain `closing_check` on the milestone's last microtask
 *     (robustness: a model that asked an integrative question but
 *     logged it via `record_closing_check` instead of the dedicated
 *     tool must not get stuck looping on `stage_synthesis_required`).
 *  Note `concept_unlocked` does NOT satisfy this — the stage checkpoint
 *  requires an actual reverse-question, not a silent advance. */
export function milestoneSynthesisSatisfied(project: PBLProjectV2, milestoneId: string): boolean {
  if (
    project.engagementEvents.some(
      (e) => e.kind === 'stage_synthesis_check' && e.milestoneId === milestoneId,
    )
  ) {
    return true;
  }
  const ms = project.milestones.find((m) => m.id === milestoneId);
  if (!ms || ms.microtasks.length === 0) return false;
  const lastMt = ms.microtasks.slice().sort((a, b) => b.order - a.order)[0];
  if (!lastMt) return false;
  return project.engagementEvents.some(
    (e) => e.kind === 'closing_check' && e.microtaskId === lastMt.id,
  );
}
