import type { RuntimeRecord } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';

import type { CoachEvent } from '@/lib/zhongkao/coach-event';
import {
  deriveOriginalObservedOutcomes,
  selectOriginalResolution,
} from '@/lib/zhongkao/coach-original-resolution';

const EPOCH = Date.parse('2026-08-28T08:00:00.000Z');

function base(eventType: CoachEvent['eventType'], seq: number) {
  return {
    schemaVersion: 1 as const,
    eventId: `event-${seq}`,
    coachSessionId: 'coach-alpha',
    profileId: 'student-alpha',
    eventType,
    createdAt: new Date(EPOCH + seq * 1000).toISOString(),
    agentSessionId: 'agent-alpha',
    operationId: `operation-${seq}`,
    operationFingerprint: seq.toString(16).padStart(64, '0'),
  };
}

function start(): CoachEvent {
  return {
    ...base('coach_started', 0),
    eventType: 'coach_started',
    sourceUserMessageSeq: 1,
    subjectId: 'math',
    knowledgePointIds: ['linear-equations'],
    questionSource: { type: 'typed' },
    questionText: 'Solve the fictional equation.',
  };
}

function attempt(seq: number): CoachEvent {
  return {
    ...base('student_attempt_submitted', seq),
    eventType: 'student_attempt_submitted',
    phase: 'original',
    sourceUserMessageSeq: seq + 1,
    studentResponse: `fictional response ${seq}`,
  };
}

function prepared(seq: number): CoachEvent {
  return {
    ...base('original_assessment_prepared', seq),
    eventType: 'original_assessment_prepared',
    assessmentVersion: 1,
    assessmentId: 'original-assessment-alpha',
    questionFingerprint: 'c'.repeat(64),
    questionType: 'numeric',
    verificationRef: 'original-verification-alpha',
    assessmentPayload: {
      gradingSpec: {
        schemaVersion: 1,
        type: 'numeric',
        expectedNumericValue: 4,
        tolerance: 0,
      },
      verification: {
        schemaVersion: 1,
        status: 'verified',
        candidateFingerprint: 'd'.repeat(64),
        verifierVersion: 1,
        checks: {
          objectiveType: true,
          questionConsistent: true,
          answerConsistent: true,
          singleAnswerOrExactSet: true,
          middleSchoolScope: true,
        },
      },
    },
  };
}

function unavailable(seq: number): CoachEvent {
  return {
    ...base('original_assessment_unavailable', seq),
    eventType: 'original_assessment_unavailable',
    assessmentVersion: 1,
    questionFingerprint: 'c'.repeat(64),
    reason: 'unsupported_question_type',
  };
}

function evaluation(
  seq: number,
  assessmentEventId: string,
  attemptEventId: string,
  outcome: 'correct' | 'incorrect',
): CoachEvent {
  return {
    ...base('original_attempt_evaluated', seq),
    eventType: 'original_attempt_evaluated',
    assessmentEventId,
    attemptEventId,
    outcome,
  };
}

function revealEvents(requestSeq: number): CoachEvent[] {
  const requested: CoachEvent = {
    ...base('full_solution_requested', requestSeq),
    eventType: 'full_solution_requested',
    phase: 'original',
    sourceUserMessageSeq: requestSeq + 1,
  };
  return [
    requested,
    {
      ...base('full_solution_revealed', requestSeq + 1),
      eventType: 'full_solution_revealed',
      phase: 'original',
      requestEventId: requested.eventId,
      explanation: 'Fictional persisted explanation.',
    },
  ];
}

function legacyResolution(
  seq: number,
  attemptEventId: string,
  fullSolutionEventId?: string,
): CoachEvent {
  return {
    ...base('original_resolved', seq),
    eventType: 'original_resolved',
    attemptEventId,
    ...(fullSolutionEventId ? { fullSolutionEventId } : { outcome: 'incorrect' as const }),
  };
}

function versionedResolution(
  seq: number,
  resolutionSchemaVersion: 2 | 3,
  kind: 'evaluated_attempt' | 'full_solution',
  causalEventId: string,
): CoachEvent {
  return {
    ...base('original_resolved', seq),
    eventType: 'original_resolved',
    resolutionSchemaVersion,
    resolutionKind: kind,
    ...(kind === 'evaluated_attempt'
      ? { evaluationEventId: causalEventId }
      : { fullSolutionEventId: causalEventId }),
  } as CoachEvent;
}

function records(events: readonly CoachEvent[]): RuntimeRecord[] {
  return events.map((event, seq) => ({
    id: `record-${seq}`,
    sessionId: 'runtime-alpha',
    seq,
    createdAt: event.createdAt,
    payload: event,
  }));
}

describe('original resolution facts', () => {
  it('selects the next unevaluated submission before any resolution', () => {
    const first = attempt(1);
    const second = attempt(2);
    const assessment = prepared(3);
    const firstEvaluation = evaluation(4, assessment.eventId, first.eventId, 'incorrect');
    expect(selectOriginalResolution([start(), first, second, assessment, firstEvaluation])).toEqual(
      {
        kind: 'evaluate_pending',
        assessmentEventId: assessment.eventId,
        attemptEventId: second.eventId,
      },
    );
  });

  it('prioritizes the latest authoritative correct evaluation over solution reveal', () => {
    const first = attempt(1);
    const second = attempt(2);
    const assessment = prepared(3);
    const correct = evaluation(4, assessment.eventId, first.eventId, 'correct');
    const incorrect = evaluation(5, assessment.eventId, second.eventId, 'incorrect');
    const events = [start(), first, second, assessment, correct, incorrect, ...revealEvents(6)];
    expect(selectOriginalResolution(events)).toEqual({
      kind: 'evaluated_attempt',
      evaluationEventId: correct.eventId,
    });
    expect(deriveOriginalObservedOutcomes(events)).toEqual({
      firstEvaluatedOutcome: 'correct',
      lastEvaluatedOutcome: 'incorrect',
    });
  });

  it('selects full solution only after every prepared evaluation is incorrect', () => {
    const first = attempt(1);
    const second = attempt(2);
    const assessment = prepared(3);
    const events = [
      start(),
      first,
      second,
      assessment,
      evaluation(4, assessment.eventId, first.eventId, 'incorrect'),
      evaluation(5, assessment.eventId, second.eventId, 'incorrect'),
      ...revealEvents(6),
    ];
    expect(selectOriginalResolution(events)).toEqual({
      kind: 'full_solution',
      fullSolutionEventId: 'event-7',
    });
    expect(deriveOriginalObservedOutcomes(events)).toEqual({
      firstEvaluatedOutcome: 'incorrect',
      lastEvaluatedOutcome: 'incorrect',
    });
  });

  it('allows unavailable plus reveal without inventing observed outcomes', () => {
    const events = [start(), attempt(1), unavailable(2), ...revealEvents(3)];
    expect(selectOriginalResolution(events)).toEqual({
      kind: 'full_solution',
      fullSolutionEventId: 'event-4',
    });
    expect(deriveOriginalObservedOutcomes(events)).toEqual({
      firstEvaluatedOutcome: undefined,
      lastEvaluatedOutcome: undefined,
    });
  });

  it('derives F1 from first and last evaluations and ignores solution reveal', () => {
    const first = attempt(1);
    const second = attempt(2);
    const assessment = prepared(3);
    const events = [
      start(),
      first,
      second,
      assessment,
      evaluation(4, assessment.eventId, first.eventId, 'incorrect'),
      evaluation(5, assessment.eventId, second.eventId, 'correct'),
      ...revealEvents(6),
    ];
    expect(deriveOriginalObservedOutcomes(events)).toEqual({
      firstEvaluatedOutcome: 'incorrect',
      lastEvaluatedOutcome: 'correct',
    });
    expect(deriveOriginalObservedOutcomes({ records: records(events) })).toEqual({
      firstEvaluatedOutcome: 'incorrect',
      lastEvaluatedOutcome: 'correct',
    });
  });

  it('fails closed when an objective history has a pending or mismatched evaluation', () => {
    const first = attempt(1);
    const second = attempt(2);
    const assessment = prepared(3);
    expect(() =>
      deriveOriginalObservedOutcomes([
        start(),
        first,
        second,
        assessment,
        evaluation(4, assessment.eventId, first.eventId, 'incorrect'),
      ]),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      selectOriginalResolution([
        start(),
        first,
        second,
        assessment,
        evaluation(4, assessment.eventId, second.eventId, 'incorrect'),
      ]),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('replays an existing durable resolution before selecting another action', () => {
    const submitted = attempt(1);
    const resolution: CoachEvent = {
      ...base('original_resolved', 2),
      eventType: 'original_resolved',
      attemptEventId: submitted.eventId,
      outcome: 'incorrect',
    };
    expect(selectOriginalResolution([start(), submitted, resolution])).toEqual({
      kind: 'existing',
      resolutionEventId: resolution.eventId,
    });
  });

  it('replays an evaluated resolution after a late reveal without changing F1', () => {
    const first = attempt(1);
    const second = attempt(2);
    const assessment = prepared(3);
    const correct = evaluation(4, assessment.eventId, first.eventId, 'correct');
    const incorrect = evaluation(5, assessment.eventId, second.eventId, 'incorrect');
    const requested = revealEvents(6);
    const resolution: CoachEvent = {
      ...base('original_resolved', 8),
      eventType: 'original_resolved',
      resolutionSchemaVersion: 3,
      resolutionKind: 'evaluated_attempt',
      evaluationEventId: correct.eventId,
    };
    const events = [
      start(),
      first,
      second,
      assessment,
      correct,
      incorrect,
      requested[0]!,
      resolution,
      requested[1]!,
    ];

    expect(selectOriginalResolution(events)).toEqual({
      kind: 'existing',
      resolutionEventId: resolution.eventId,
    });
    expect(deriveOriginalObservedOutcomes(events)).toEqual({
      firstEvaluatedOutcome: 'correct',
      lastEvaluatedOutcome: 'incorrect',
    });
  });

  it('rejects missing, wrong-type, and later legacy causal references', () => {
    const submitted = attempt(1);
    const missing = legacyResolution(2, 'missing-attempt');
    const wrongType = legacyResolution(2, start().eventId);
    const beforeAttempt = legacyResolution(1, 'event-2');

    expect(() => selectOriginalResolution([start(), submitted, missing])).toThrow(
      'COACH_EVENT_CONFLICT',
    );
    expect(() =>
      selectOriginalResolution({ records: records([start(), submitted, wrongType]) }),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() => selectOriginalResolution([start(), beforeAttempt, attempt(2)])).toThrow(
      'COACH_EVENT_CONFLICT',
    );
  });

  it('rejects missing, wrong-type, and later reveal references', () => {
    const submitted = attempt(1);
    const reveal = revealEvents(2);
    expect(() =>
      selectOriginalResolution([
        start(),
        submitted,
        legacyResolution(4, submitted.eventId, 'missing-reveal'),
      ]),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      selectOriginalResolution([
        start(),
        submitted,
        legacyResolution(4, submitted.eventId, submitted.eventId),
      ]),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      selectOriginalResolution([
        start(),
        submitted,
        reveal[0]!,
        legacyResolution(3, submitted.eventId, reveal[1]!.eventId),
        reveal[1]!,
      ]),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('validates v2 last-evaluation compatibility without accepting an arbitrary evaluation ref', () => {
    const first = attempt(1);
    const second = attempt(2);
    const assessment = prepared(3);
    const correct = evaluation(4, assessment.eventId, first.eventId, 'correct');
    const incorrect = evaluation(5, assessment.eventId, second.eventId, 'incorrect');
    const reveal = revealEvents(6);
    const history = [start(), first, second, assessment, correct, incorrect, ...reveal];

    expect(
      selectOriginalResolution([
        ...history,
        versionedResolution(8, 2, 'full_solution', reveal[1]!.eventId),
      ]),
    ).toEqual({ kind: 'existing', resolutionEventId: 'event-8' });
    expect(() =>
      selectOriginalResolution([
        ...history,
        versionedResolution(8, 2, 'evaluated_attempt', correct.eventId),
      ]),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      selectOriginalResolution([
        start(),
        first,
        assessment,
        evaluation(4, assessment.eventId, first.eventId, 'incorrect'),
        versionedResolution(5, 2, 'evaluated_attempt', 'event-4'),
      ]),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('requires an existing v3 resolution to match the deterministic any-correct decision', () => {
    const first = attempt(1);
    const second = attempt(2);
    const assessment = prepared(3);
    const firstCorrect = evaluation(4, assessment.eventId, first.eventId, 'correct');
    const lastCorrect = evaluation(5, assessment.eventId, second.eventId, 'correct');
    const reveal = revealEvents(6);
    const history = [start(), first, second, assessment, firstCorrect, lastCorrect, ...reveal];

    expect(
      selectOriginalResolution([
        ...history,
        versionedResolution(8, 3, 'evaluated_attempt', lastCorrect.eventId),
      ]),
    ).toEqual({ kind: 'existing', resolutionEventId: 'event-8' });
    expect(() =>
      selectOriginalResolution([
        ...history,
        versionedResolution(8, 3, 'evaluated_attempt', firstCorrect.eventId),
      ]),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      selectOriginalResolution([
        ...history,
        versionedResolution(8, 3, 'full_solution', reveal[1]!.eventId),
      ]),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('accepts unavailable only with a prior v3 full-solution fact', () => {
    const submitted = attempt(1);
    const terminal = unavailable(2);
    const reveal = revealEvents(3);
    const history = [start(), submitted, terminal, ...reveal];
    expect(
      selectOriginalResolution([
        ...history,
        versionedResolution(5, 3, 'full_solution', reveal[1]!.eventId),
      ]),
    ).toEqual({ kind: 'existing', resolutionEventId: 'event-5' });
    expect(() =>
      selectOriginalResolution([
        ...history,
        versionedResolution(5, 2, 'full_solution', reveal[1]!.eventId),
      ]),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      selectOriginalResolution([
        ...history,
        legacyResolution(5, submitted.eventId, reveal[1]!.eventId),
      ]),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('rejects an existing prepared resolution while an original submission is unevaluated', () => {
    const first = attempt(1);
    const second = attempt(2);
    const assessment = prepared(3);
    const incorrect = evaluation(4, assessment.eventId, first.eventId, 'incorrect');
    const reveal = revealEvents(5);
    expect(() =>
      selectOriginalResolution([
        start(),
        first,
        second,
        assessment,
        incorrect,
        ...reveal,
        versionedResolution(7, 3, 'full_solution', reveal[1]!.eventId),
      ]),
    ).toThrow('COACH_EVENT_CONFLICT');
  });
});
