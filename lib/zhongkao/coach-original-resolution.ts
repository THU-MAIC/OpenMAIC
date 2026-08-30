import type { RuntimeRecord } from '@openmaic/dsl';

import { CoachError } from './coach-errors';
import {
  COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION,
  COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION_V2,
  assertCoachEvent,
  type CoachEvent,
  type CoachTransferOutcome,
  type OriginalAssessmentPreparedEvent,
  type OriginalAssessmentUnavailableEvent,
  type OriginalAttemptEvaluatedEvent,
} from './coach-event';

export interface CoachOriginalEventRecordSource {
  records: readonly RuntimeRecord[];
}

/** Production sources must already have passed incremental foldCoachEvents validation. */
export type CoachOriginalEventSource = readonly CoachEvent[] | CoachOriginalEventRecordSource;

export type CoachOriginalResolutionDecision =
  | { kind: 'existing'; resolutionEventId: string }
  | { kind: 'evaluate_pending'; assessmentEventId: string; attemptEventId: string }
  | { kind: 'evaluated_attempt'; evaluationEventId: string }
  | { kind: 'full_solution'; fullSolutionEventId: string }
  | { kind: 'unresolved' };

export interface CoachOriginalObservedOutcomes {
  firstEvaluatedOutcome: CoachTransferOutcome | undefined;
  lastEvaluatedOutcome: CoachTransferOutcome | undefined;
}

type AssessmentTerminalEvent = OriginalAssessmentPreparedEvent | OriginalAssessmentUnavailableEvent;

interface OriginalResolutionFacts {
  assessment: AssessmentTerminalEvent | undefined;
  attempts: Extract<CoachEvent, { eventType: 'student_attempt_submitted' }>[];
  evaluations: OriginalAttemptEvaluatedEvent[];
  reveal: Extract<CoachEvent, { eventType: 'full_solution_revealed' }> | undefined;
  resolution: Extract<CoachEvent, { eventType: 'original_resolved' }> | undefined;
  eventById: ReadonlyMap<string, CoachEvent>;
  indexByEventId: ReadonlyMap<string, number>;
  resolutionIndex: number;
}

function conflict(): never {
  throw new CoachError('COACH_EVENT_CONFLICT');
}

function eventsFrom(source: CoachOriginalEventSource): readonly CoachEvent[] {
  if (Array.isArray(source)) {
    source.forEach(assertCoachEvent);
    return source;
  }
  const recordSource = source as CoachOriginalEventRecordSource;
  return recordSource.records.map((record: RuntimeRecord) => {
    assertCoachEvent(record.payload);
    return record.payload;
  });
}

function collectOriginalResolutionFacts(source: CoachOriginalEventSource): OriginalResolutionFacts {
  const events = eventsFrom(source);
  if (events.length === 0) conflict();
  const eventIds = new Set<string>();
  const eventById = new Map<string, CoachEvent>();
  const indexByEventId = new Map<string, number>();
  const assessments: AssessmentTerminalEvent[] = [];
  const attempts: OriginalResolutionFacts['attempts'] = [];
  const evaluations: OriginalAttemptEvaluatedEvent[] = [];
  const reveals: OriginalResolutionFacts['reveal'][] = [];
  const resolutions: OriginalResolutionFacts['resolution'][] = [];
  let assessmentIndex = -1;
  let resolutionIndex = -1;
  const identity = events[0]
    ? { coachSessionId: events[0].coachSessionId, profileId: events[0].profileId }
    : undefined;

  events.forEach((event, index) => {
    if (
      eventIds.has(event.eventId) ||
      !identity ||
      event.coachSessionId !== identity.coachSessionId ||
      event.profileId !== identity.profileId
    ) {
      conflict();
    }
    eventIds.add(event.eventId);
    eventById.set(event.eventId, event);
    indexByEventId.set(event.eventId, index);
    switch (event.eventType) {
      case 'original_assessment_prepared':
      case 'original_assessment_unavailable':
        assessments.push(event);
        assessmentIndex = index;
        break;
      case 'student_attempt_submitted':
        attempts.push(event);
        break;
      case 'original_attempt_evaluated':
        evaluations.push(event);
        break;
      case 'full_solution_revealed':
        reveals.push(event);
        break;
      case 'original_resolved':
        resolutions.push(event);
        resolutionIndex = index;
        break;
      default:
        break;
    }
  });

  if (assessments.length > 1 || reveals.length > 1 || resolutions.length > 1) conflict();
  const assessment = assessments[0];
  const resolution = resolutions[0];
  if (assessment && (attempts.length === 0 || events.indexOf(attempts[0]!) > assessmentIndex)) {
    conflict();
  }
  if (!assessment && evaluations.length > 0) conflict();
  if (assessment?.eventType === 'original_assessment_unavailable' && evaluations.length > 0) {
    conflict();
  }
  if (evaluations.length > attempts.length) conflict();

  evaluations.forEach((evaluation, index) => {
    const attempt = attempts[index];
    if (
      assessment?.eventType !== 'original_assessment_prepared' ||
      evaluation.assessmentEventId !== assessment.eventId ||
      !attempt ||
      evaluation.attemptEventId !== attempt.eventId ||
      events.indexOf(evaluation) <= assessmentIndex ||
      events.indexOf(evaluation) <= events.indexOf(attempt)
    ) {
      conflict();
    }
  });

  if (resolution) {
    const hasLaterOriginalFact = events
      .slice(resolutionIndex + 1)
      .some((event) =>
        [
          'student_attempt_submitted',
          'original_assessment_prepared',
          'original_assessment_unavailable',
          'original_attempt_evaluated',
        ].includes(event.eventType),
      );
    if (hasLaterOriginalFact) conflict();
  }

  return {
    assessment,
    attempts,
    evaluations,
    reveal: reveals[0],
    resolution,
    eventById,
    indexByEventId,
    resolutionIndex,
  };
}

function requirePriorEvent<TType extends CoachEvent['eventType']>(
  facts: OriginalResolutionFacts,
  eventId: string,
  eventType: TType,
): Extract<CoachEvent, { eventType: TType }> {
  const event = facts.eventById.get(eventId);
  const eventIndex = facts.indexByEventId.get(eventId);
  if (
    !event ||
    event.eventType !== eventType ||
    eventIndex === undefined ||
    facts.resolutionIndex < 0 ||
    eventIndex >= facts.resolutionIndex
  ) {
    conflict();
  }
  return event as Extract<CoachEvent, { eventType: TType }>;
}

function selectUnresolvedResolution(
  facts: OriginalResolutionFacts,
): Exclude<CoachOriginalResolutionDecision, { kind: 'existing' }> {
  if (!facts.assessment) return { kind: 'unresolved' };

  if (facts.assessment.eventType === 'original_assessment_unavailable') {
    return facts.reveal
      ? { kind: 'full_solution', fullSolutionEventId: facts.reveal.eventId }
      : { kind: 'unresolved' };
  }

  const pendingAttempt = facts.attempts[facts.evaluations.length];
  if (pendingAttempt) {
    return {
      kind: 'evaluate_pending',
      assessmentEventId: facts.assessment.eventId,
      attemptEventId: pendingAttempt.eventId,
    };
  }

  const correctEvaluation = [...facts.evaluations]
    .reverse()
    .find((evaluation) => evaluation.outcome === 'correct');
  if (correctEvaluation) {
    return { kind: 'evaluated_attempt', evaluationEventId: correctEvaluation.eventId };
  }
  if (facts.reveal) {
    return { kind: 'full_solution', fullSolutionEventId: facts.reveal.eventId };
  }
  return { kind: 'unresolved' };
}

function validateExistingResolution(facts: OriginalResolutionFacts): void {
  const resolution = facts.resolution;
  if (!resolution) conflict();
  if (
    facts.assessment?.eventType === 'original_assessment_prepared' &&
    facts.evaluations.length !== facts.attempts.length
  ) {
    conflict();
  }

  if (resolution.resolutionSchemaVersion === undefined) {
    if (facts.assessment?.eventType === 'original_assessment_unavailable') conflict();
    const attempt = requirePriorEvent(
      facts,
      resolution.attemptEventId,
      'student_attempt_submitted',
    );
    if (attempt.phase !== 'original') conflict();
    if (resolution.fullSolutionEventId !== undefined) {
      requirePriorEvent(facts, resolution.fullSolutionEventId, 'full_solution_revealed');
    }
    return;
  }

  if (resolution.resolutionSchemaVersion === COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION_V2) {
    if (facts.assessment?.eventType === 'original_assessment_unavailable') conflict();
    if (resolution.resolutionKind === 'evaluated_attempt') {
      const evaluation = requirePriorEvent(
        facts,
        resolution.evaluationEventId,
        'original_attempt_evaluated',
      );
      if (evaluation.outcome !== 'correct' || facts.evaluations.at(-1) !== evaluation) conflict();
    } else {
      requirePriorEvent(facts, resolution.fullSolutionEventId, 'full_solution_revealed');
    }
    return;
  }

  if (resolution.resolutionSchemaVersion !== COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION) conflict();
  if (resolution.resolutionKind === 'evaluated_attempt') {
    requirePriorEvent(facts, resolution.evaluationEventId, 'original_attempt_evaluated');
  } else {
    requirePriorEvent(facts, resolution.fullSolutionEventId, 'full_solution_revealed');
  }
  const expected = selectUnresolvedResolution(facts);
  if (
    (resolution.resolutionKind === 'evaluated_attempt' &&
      (expected.kind !== 'evaluated_attempt' ||
        expected.evaluationEventId !== resolution.evaluationEventId)) ||
    (resolution.resolutionKind === 'full_solution' &&
      (expected.kind !== 'full_solution' ||
        expected.fullSolutionEventId !== resolution.fullSolutionEventId))
  ) {
    conflict();
  }
}

/** Selects the next server-owned original-resolution action from durable facts only. */
export function selectOriginalResolution(
  source: CoachOriginalEventSource,
): CoachOriginalResolutionDecision {
  const facts = collectOriginalResolutionFacts(source);
  if (facts.resolution) {
    validateExistingResolution(facts);
    return { kind: 'existing', resolutionEventId: facts.resolution.eventId };
  }
  return selectUnresolvedResolution(facts);
}

/** F1 uses only the first and last authoritative evaluations; solution reveal never changes it. */
export function deriveOriginalObservedOutcomes(
  source: CoachOriginalEventSource,
): CoachOriginalObservedOutcomes {
  const facts = collectOriginalResolutionFacts(source);
  if (facts.resolution) validateExistingResolution(facts);
  if (facts.assessment?.eventType === 'original_assessment_unavailable') {
    return { firstEvaluatedOutcome: undefined, lastEvaluatedOutcome: undefined };
  }
  if (
    facts.assessment?.eventType !== 'original_assessment_prepared' ||
    facts.evaluations.length !== facts.attempts.length ||
    facts.evaluations.length === 0
  ) {
    conflict();
  }
  return {
    firstEvaluatedOutcome: facts.evaluations[0]!.outcome,
    lastEvaluatedOutcome: facts.evaluations.at(-1)!.outcome,
  };
}
