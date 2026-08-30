import { CoachError } from '@/lib/zhongkao/coach-errors';
import type { CoachEvent, CoachOutcome } from '@/lib/zhongkao/coach-event';
import {
  appendCoachRuntimeEvent,
  createCoachOperationFingerprint,
  deriveCoachCausalOperationId,
} from '@/lib/server/zhongkao/coach-runtime';
import type {
  CoachActionResult,
  CoachContinuationInput,
  CoachServiceDeps,
} from '@/lib/server/zhongkao/coach-service';

type LegacyOriginalResolutionFacts =
  | { attemptEventId: string; outcome: CoachOutcome; fullSolutionEventId?: never }
  | { attemptEventId: string; fullSolutionEventId: string; outcome?: never };

/** Creates committed pre-assessment histories for compatibility-only tests. */
export async function recordLegacyOriginalResolvedFixture(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & LegacyOriginalResolutionFacts,
): Promise<CoachActionResult> {
  const resolvesFromFullSolution = input.fullSolutionEventId !== undefined;
  const causalEventId = resolvesFromFullSolution ? input.fullSolutionEventId : input.attemptEventId;
  const operationId = deriveCoachCausalOperationId({
    coachSessionId: input.coachSessionId,
    action: 'record_original_resolved',
    causalEventId,
  });
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'record_original_resolved',
    coachSessionId: input.coachSessionId,
    attemptEventId: input.attemptEventId,
    ...(resolvesFromFullSolution
      ? { fullSolutionEventId: input.fullSolutionEventId }
      : { outcome: input.outcome }),
  });
  return appendCoachRuntimeEvent(deps, {
    profileId: input.profileId,
    coachSessionId: input.coachSessionId,
    expectedRevision: input.expectedRevision,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      const events = snapshot.records.map((record) => record.payload as CoachEvent);
      const attempt = events.find((event) => event.eventId === input.attemptEventId);
      if (
        !attempt ||
        attempt.eventType !== 'student_attempt_submitted' ||
        attempt.phase !== 'original'
      ) {
        throw new CoachError('STUDENT_ATTEMPT_REQUIRED');
      }
      const fullSolution = resolvesFromFullSolution
        ? events.find((event) => event.eventId === input.fullSolutionEventId)
        : undefined;
      if (
        resolvesFromFullSolution &&
        (!fullSolution ||
          fullSolution.eventType !== 'full_solution_revealed' ||
          fullSolution.phase !== 'original' ||
          !snapshot.state.original.viewedFullAnswer)
      ) {
        throw new CoachError('COACH_ACTION_NOT_ALLOWED');
      }
      if (snapshot.state.original.resolved || snapshot.state.status === 'abandoned') {
        throw new CoachError('COACH_ACTION_NOT_ALLOWED');
      }
      return {
        schemaVersion: 1,
        ...metadata,
        coachSessionId: input.coachSessionId,
        profileId: input.profileId,
        eventType: 'original_resolved',
        agentSessionId: deps.agentSessionId,
        attemptEventId: attempt.eventId,
        ...(resolvesFromFullSolution
          ? { fullSolutionEventId: input.fullSolutionEventId }
          : { outcome: input.outcome }),
      };
    },
  });
}
