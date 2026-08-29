import { describe, expect, it } from 'vitest';

import {
  COACH_FINAL_ANSWER_MAX_LENGTH,
  COACH_HINT_TEXT_MAX_LENGTH,
  COACH_OPERATION_FINGERPRINT_LENGTH,
  COACH_SOLUTION_EXPLANATION_MAX_LENGTH,
  COACH_TRUSTED_MESSAGE_MAX_LENGTH,
  coachEventFactsEqual,
  validateCoachEvent,
  type CoachEvent,
} from '@/lib/zhongkao/coach-event';

const NOW = '2026-08-28T08:00:00.000Z';
const FINGERPRINT = 'a'.repeat(COACH_OPERATION_FINGERPRINT_LENGTH);

function common(eventType: CoachEvent['eventType']) {
  return {
    schemaVersion: 1 as const,
    eventId: `event-${eventType}`,
    coachSessionId: 'coach-session-alpha',
    profileId: 'student-alpha',
    eventType,
    createdAt: NOW,
    agentSessionId: 'agent-chat-alpha',
    operationId: `operation-${eventType}`,
    operationFingerprint: FINGERPRINT,
  };
}

const VALID_EVENTS: CoachEvent[] = [
  {
    ...common('coach_started'),
    eventType: 'coach_started',
    sourceUserMessageSeq: 1,
    subjectId: 'math',
    knowledgePointIds: ['linear-equations'],
    questionSource: { type: 'typed' },
    questionText: 'Solve the fictional equation.',
  },
  {
    ...common('student_attempt_submitted'),
    eventType: 'student_attempt_submitted',
    phase: 'original',
    sourceUserMessageSeq: 2,
    studentResponse: 'x equals 4',
  },
  {
    ...common('hint_requested'),
    eventType: 'hint_requested',
    phase: 'original',
    sourceUserMessageSeq: 3,
  },
  {
    ...common('hint_issued'),
    eventType: 'hint_issued',
    phase: 'original',
    requestEventId: 'event-hint-requested',
    hintNumber: 1,
    hintText: 'Recall how inverse operations isolate the unknown.',
  },
  {
    ...common('full_solution_requested'),
    eventType: 'full_solution_requested',
    phase: 'original',
    sourceUserMessageSeq: 4,
  },
  {
    ...common('full_solution_revealed'),
    eventType: 'full_solution_revealed',
    phase: 'original',
    requestEventId: 'event-full-solution-requested',
    explanation: 'Subtract and divide step by step to isolate the unknown.',
    finalAnswer: 'x = 4',
  },
  {
    ...common('original_resolved'),
    eventType: 'original_resolved',
    attemptEventId: 'event-student-attempt-submitted',
    outcome: 'incorrect',
  },
  {
    ...common('transfer_question_assigned'),
    eventType: 'transfer_question_assigned',
    originalResolvedEventId: 'event-original-resolved',
    transferQuestionId: 'transfer-alpha',
    knowledgePointIds: ['linear-equations'],
    validationRef: 'verified-generator-alpha',
  },
  {
    ...common('transfer_answer_submitted'),
    eventType: 'transfer_answer_submitted',
    phase: 'transfer',
    transferQuestionId: 'transfer-alpha',
    sourceUserMessageSeq: 5,
    studentResponse: 'x equals 7',
  },
  {
    ...common('transfer_answer_evaluated'),
    eventType: 'transfer_answer_evaluated',
    transferQuestionId: 'transfer-alpha',
    submissionEventId: 'event-transfer-answer-submitted',
    outcome: 'correct',
  },
  {
    ...common('study_attempts_projected'),
    eventType: 'study_attempts_projected',
    evaluationEventId: 'event-transfer-answer-evaluated',
    projectionRef: 'projection-alpha',
    projectionVersion: 1,
  },
  {
    ...common('problem_abandoned'),
    eventType: 'problem_abandoned',
    sourceUserMessageSeq: 6,
  },
  {
    ...common('presentation_failed'),
    eventType: 'presentation_failed',
    phase: 'original',
    presentationKind: 'hint',
    requestEventId: 'event-hint-requested',
    failureCode: 'HINT_GENERATION_FAILED',
  },
];

describe('Coach event contract', () => {
  it.each(VALID_EVENTS)('accepts closed $eventType payloads', (event) => {
    expect(validateCoachEvent(event)).toEqual({ valid: true });
  });

  it.each([null, [], 'event', 1])('rejects non-object payload %j', (value) => {
    expect(validateCoachEvent(value).valid).toBe(false);
  });

  it('requires a fixed lowercase SHA-256 operation fingerprint', () => {
    const start = VALID_EVENTS[0]!;
    for (const operationFingerprint of ['', 'a'.repeat(63), 'A'.repeat(64), 'z'.repeat(64)]) {
      expect(validateCoachEvent({ ...start, operationFingerprint }).valid).toBe(false);
    }
  });

  it('rejects unknown versions, event enums, timestamps, and extra fields', () => {
    const start = VALID_EVENTS[0]!;
    expect(validateCoachEvent({ ...start, schemaVersion: 2 }).valid).toBe(false);
    expect(validateCoachEvent({ ...start, eventType: 'model_mastered' }).valid).toBe(false);
    expect(validateCoachEvent({ ...start, createdAt: '2027-02-30T10:00:00.000Z' }).valid).toBe(
      false,
    );
    expect(validateCoachEvent({ ...start, answerUnlocked: true }).valid).toBe(false);
  });

  it.each(['answerUnlocked', 'isIndependent', 'mastered', 'verifiedSource', 'answerKey', 'rubric'])(
    'rejects forbidden derived field %s',
    (field) => {
      expect(validateCoachEvent({ ...VALID_EVENTS[0], [field]: true }).valid).toBe(false);
    },
  );

  it('requires exact event-specific phase values', () => {
    expect(validateCoachEvent({ ...VALID_EVENTS[1], phase: 'transfer' }).valid).toBe(false);
    expect(validateCoachEvent({ ...VALID_EVENTS[4], phase: 'transfer' }).valid).toBe(false);
    expect(validateCoachEvent({ ...VALID_EVENTS[8], phase: 'original' }).valid).toBe(false);
    expect(validateCoachEvent({ ...VALID_EVENTS[2], phase: 'future' }).valid).toBe(false);
  });

  it('requires causal references on all server facts', () => {
    for (const event of VALID_EVENTS.slice(3, 11)) {
      const causalField =
        event.eventType === 'hint_issued' || event.eventType === 'full_solution_revealed'
          ? 'requestEventId'
          : event.eventType === 'original_resolved'
            ? 'attemptEventId'
            : event.eventType === 'transfer_question_assigned'
              ? 'originalResolvedEventId'
              : event.eventType === 'transfer_answer_evaluated'
                ? 'submissionEventId'
                : event.eventType === 'study_attempts_projected'
                  ? 'evaluationEventId'
                  : undefined;
      if (!causalField) continue;
      const without = { ...event } as Record<string, unknown>;
      delete without[causalField];
      expect(validateCoachEvent(without).valid).toBe(false);
    }
  });

  it('keeps presentation failure facts closed and server-owned', () => {
    const failure = VALID_EVENTS.at(-1)!;
    expect(validateCoachEvent({ ...failure, requestEventId: undefined }).valid).toBe(false);
    expect(validateCoachEvent({ ...failure, presentationKind: 'answer' }).valid).toBe(false);
    expect(validateCoachEvent({ ...failure, failureCode: 'PRIVATE_PROVIDER_ERROR' }).valid).toBe(
      false,
    );
    expect(
      validateCoachEvent({
        ...failure,
        phase: 'transfer',
        presentationKind: 'full_solution',
      }).valid,
    ).toBe(false);
    expect(
      validateCoachEvent({
        ...failure,
        presentationKind: 'hint',
        failureCode: 'FULL_SOLUTION_GENERATION_FAILED',
      }).valid,
    ).toBe(false);
    expect(
      validateCoachEvent({
        ...failure,
        presentationKind: 'full_solution',
        failureCode: 'HINT_CONTENT_INVALID',
      }).valid,
    ).toBe(false);
    expect(
      validateCoachEvent({
        ...failure,
        presentationKind: 'hint',
        failureCode: 'COACH_RUNTIME_UNAVAILABLE',
      }).valid,
    ).toBe(true);
    expect(
      validateCoachEvent({
        ...failure,
        presentationKind: 'full_solution',
        failureCode: 'MATERIAL_SOURCE_NOT_VERIFIED',
      }).valid,
    ).toBe(true);
  });

  it('rejects invalid durable message seq and trusted text', () => {
    const attempt = VALID_EVENTS[1]!;
    const withoutSeq = { ...attempt } as Record<string, unknown>;
    delete withoutSeq.sourceUserMessageSeq;
    for (const value of [
      withoutSeq,
      { ...attempt, sourceUserMessageSeq: 0 },
      { ...attempt, sourceUserMessageSeq: 1.5 },
      { ...attempt, studentResponse: '   ' },
      { ...attempt, studentResponse: ' padded ' },
      { ...attempt, studentResponse: 'x'.repeat(COACH_TRUSTED_MESSAGE_MAX_LENGTH + 1) },
    ]) {
      expect(validateCoachEvent(value).valid).toBe(false);
    }
  });

  it('rejects duplicate knowledge ids and unverified material embellishments', () => {
    const start = VALID_EVENTS[0]!;
    expect(validateCoachEvent({ ...start, knowledgePointIds: [] }).valid).toBe(false);
    expect(
      validateCoachEvent({
        ...start,
        knowledgePointIds: ['linear-equations', 'linear-equations'],
      }).valid,
    ).toBe(false);
    expect(
      validateCoachEvent({
        ...start,
        questionSource: { type: 'material', materialId: 'fictional-material', verified: true },
      }).valid,
    ).toBe(false);
  });

  it('rejects invalid hint, outcome, question, and projection facts', () => {
    expect(validateCoachEvent({ ...VALID_EVENTS[3], hintNumber: 4 }).valid).toBe(false);
    expect(validateCoachEvent({ ...VALID_EVENTS[6], outcome: 'mastered' }).valid).toBe(false);
    expect(validateCoachEvent({ ...VALID_EVENTS[8], transferQuestionId: '' }).valid).toBe(false);
    expect(validateCoachEvent({ ...VALID_EVENTS[10], projectionVersion: 2 }).valid).toBe(false);
  });

  it('round-trips bounded presentation facts and rejects missing, padded, oversized, or hidden content', () => {
    const hint = VALID_EVENTS[3]!;
    const solution = VALID_EVENTS[5]!;
    for (const value of [
      { ...hint, hintText: undefined },
      { ...hint, hintText: ' padded ' },
      { ...hint, hintText: 'x'.repeat(COACH_HINT_TEXT_MAX_LENGTH + 1) },
      { ...hint, hiddenReasoning: 'private' },
      { ...solution, explanation: undefined },
      { ...solution, explanation: 'x'.repeat(COACH_SOLUTION_EXPLANATION_MAX_LENGTH + 1) },
      { ...solution, finalAnswer: ' ' },
      { ...solution, finalAnswer: 'x'.repeat(COACH_FINAL_ANSWER_MAX_LENGTH + 1) },
      { ...solution, hiddenReasoning: 'private' },
    ]) {
      expect(validateCoachEvent(value).valid).toBe(false);
    }
    expect(JSON.parse(JSON.stringify(hint))).toEqual(hint);
    expect(JSON.parse(JSON.stringify(solution))).toEqual(solution);
  });

  it('compares persisted facts independently of object key insertion order', () => {
    const event = VALID_EVENTS[0]!;
    const reordered = Object.fromEntries(Object.entries(event).toReversed()) as CoachEvent;
    expect(coachEventFactsEqual(event, reordered)).toBe(true);
    const changed = { ...event, questionText: 'Different question.' } as CoachEvent;
    expect(coachEventFactsEqual(event, changed)).toBe(false);
  });
});
