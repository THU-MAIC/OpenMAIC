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

const VERIFIED_TRANSFER_CHECKS = {
  sameKnowledgePoint: true,
  selfContained: true,
  answerConsistent: true,
  answerNotLeaked: true,
  singleAnswerOrExactSet: true,
  middleSchoolScope: true,
  meaningfullyDifferent: true,
} as const;

const VERIFIED_ORIGINAL_ASSESSMENT_CHECKS = {
  objectiveType: true,
  questionConsistent: true,
  answerConsistent: true,
  singleAnswerOrExactSet: true,
  middleSchoolScope: true,
} as const;

function originalAssessmentEvent(): Extract<
  CoachEvent,
  { eventType: 'original_assessment_prepared' }
> {
  return {
    ...common('original_assessment_prepared'),
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
        checks: VERIFIED_ORIGINAL_ASSESSMENT_CHECKS,
      },
    },
  };
}

function originalEvaluationEvent(
  outcome: 'correct' | 'incorrect' = 'correct',
): Extract<CoachEvent, { eventType: 'original_attempt_evaluated' }> {
  return {
    ...common('original_attempt_evaluated'),
    eventType: 'original_attempt_evaluated',
    assessmentEventId: 'event-original-assessment-prepared',
    attemptEventId: 'event-student-attempt-submitted',
    outcome,
  };
}

function evaluatedResolutionEvent(): Extract<
  CoachEvent,
  { eventType: 'original_resolved'; resolutionKind: 'evaluated_attempt' }
> {
  return {
    ...common('original_resolved'),
    eventType: 'original_resolved',
    resolutionSchemaVersion: 2,
    resolutionKind: 'evaluated_attempt',
    evaluationEventId: 'event-original-attempt-evaluated',
  };
}

function fullSolutionResolutionEvent(): Extract<
  CoachEvent,
  { eventType: 'original_resolved'; resolutionKind: 'full_solution' }
> {
  return {
    ...common('original_resolved'),
    eventType: 'original_resolved',
    resolutionSchemaVersion: 2,
    resolutionKind: 'full_solution',
    fullSolutionEventId: 'event-full-solution-revealed',
  };
}

function enrichedAssignment(
  publicQuestion: Record<string, unknown>,
  gradingSpec: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...VALID_EVENTS[7],
    assignmentSchemaVersion: 1,
    assignmentPayload: {
      publicQuestion,
      gradingSpec,
      verification: {
        schemaVersion: 1,
        status: 'verified',
        candidateFingerprint: 'b'.repeat(64),
        verifierVersion: 1,
        checks: VERIFIED_TRANSFER_CHECKS,
      },
    },
  };
}

function choiceQuestion(type: 'single_choice' | 'multiple_choice') {
  return {
    schemaVersion: 1,
    transferQuestionId: 'transfer-alpha',
    type,
    question: 'Choose the answer for this fictional transfer question.',
    options: [
      { id: 'option-a', text: 'Fictional option A' },
      { id: 'option-b', text: 'Fictional option B' },
      { id: 'option-c', text: 'Fictional option C' },
    ],
    knowledgePointIds: ['linear-equations'],
    difficulty: 'same',
  };
}

function openQuestion(type: 'numeric' | 'exact_short_answer') {
  return {
    schemaVersion: 1,
    transferQuestionId: 'transfer-alpha',
    type,
    question: 'Give the answer for this fictional transfer question.',
    knowledgePointIds: ['linear-equations'],
    difficulty: 'same',
  };
}

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

  it('accepts legacy outcome and full-solution resolutions but rejects both or neither', () => {
    const legacy = VALID_EVENTS[6]!;
    expect(validateCoachEvent(legacy).valid).toBe(true);

    const fromFullSolution = { ...legacy } as Record<string, unknown>;
    delete fromFullSolution.outcome;
    fromFullSolution.fullSolutionEventId = 'event-full-solution-revealed';
    expect(validateCoachEvent(fromFullSolution).valid).toBe(true);
    expect(
      validateCoachEvent({ ...legacy, fullSolutionEventId: 'event-full-solution-revealed' }).valid,
    ).toBe(false);

    const neither = { ...legacy } as Record<string, unknown>;
    delete neither.outcome;
    expect(validateCoachEvent(neither).valid).toBe(false);
  });

  it('accepts closed original assessment, evaluation, and v2 resolution events', () => {
    for (const event of [
      originalAssessmentEvent(),
      originalEvaluationEvent('correct'),
      originalEvaluationEvent('incorrect'),
      evaluatedResolutionEvent(),
      fullSolutionResolutionEvent(),
    ]) {
      expect(validateCoachEvent(event)).toEqual({ valid: true });
    }
  });

  it('keeps every original assessment layer closed and server-verified', () => {
    const assessment = originalAssessmentEvent();
    const payload = assessment.assessmentPayload as Record<string, unknown>;
    const gradingSpec = payload.gradingSpec as Record<string, unknown>;
    const verification = payload.verification as Record<string, unknown>;
    for (const value of [
      { ...assessment, expectedAnswer: 4 },
      { ...assessment, questionType: 'essay' },
      { ...assessment, assessmentPayload: { ...payload, expectedAnswer: 4 } },
      {
        ...assessment,
        assessmentPayload: {
          ...payload,
          gradingSpec: { ...gradingSpec, rubric: 'private rubric' },
        },
      },
      {
        ...assessment,
        assessmentPayload: {
          ...payload,
          verification: { ...verification, status: 'candidate' },
        },
      },
      {
        ...assessment,
        assessmentPayload: {
          ...payload,
          verification: {
            ...verification,
            checks: { ...VERIFIED_ORIGINAL_ASSESSMENT_CHECKS, answerNotLeaked: true },
          },
        },
      },
      {
        ...assessment,
        assessmentPayload: {
          ...payload,
          verification: { ...verification, verifierReasoning: 'hidden reasoning' },
        },
      },
    ]) {
      expect(validateCoachEvent(value).valid).toBe(false);
    }
  });

  it('limits original evaluations to exact causal refs and correct or incorrect', () => {
    const evaluation = originalEvaluationEvent();
    expect(validateCoachEvent({ ...evaluation, outcome: 'partial' }).valid).toBe(false);
    expect(validateCoachEvent({ ...evaluation, outcome: 'skipped' }).valid).toBe(false);
    expect(validateCoachEvent({ ...evaluation, studentResponse: 'private response' }).valid).toBe(
      false,
    );

    for (const causalField of ['assessmentEventId', 'attemptEventId'] as const) {
      const missing = { ...evaluation } as Record<string, unknown>;
      delete missing[causalField];
      expect(validateCoachEvent(missing).valid).toBe(false);
    }
  });

  it('keeps v2 original resolutions as closed causal branches without outcomes', () => {
    const evaluated = evaluatedResolutionEvent();
    const fullSolution = fullSolutionResolutionEvent();
    for (const value of [
      { ...evaluated, resolutionSchemaVersion: 1 },
      { ...evaluated, outcome: 'correct' },
      { ...evaluated, attemptEventId: 'event-student-attempt-submitted' },
      { ...evaluated, fullSolutionEventId: 'event-full-solution-revealed' },
      { ...fullSolution, outcome: 'correct' },
      { ...fullSolution, attemptEventId: 'event-student-attempt-submitted' },
      { ...fullSolution, evaluationEventId: 'event-original-attempt-evaluated' },
      { ...fullSolution, resolutionKind: 'model_decided' },
    ]) {
      expect(validateCoachEvent(value).valid).toBe(false);
    }

    const missingEvaluation = { ...evaluated } as Record<string, unknown>;
    delete missingEvaluation.evaluationEventId;
    expect(validateCoachEvent(missingEvaluation).valid).toBe(false);
    const missingReveal = { ...fullSolution } as Record<string, unknown>;
    delete missingReveal.fullSolutionEventId;
    expect(validateCoachEvent(missingReveal).valid).toBe(false);
  });

  it('keeps legacy assignments readable and accepts all four closed verified assignment branches', () => {
    expect(validateCoachEvent(VALID_EVENTS[7])).toEqual({ valid: true });
    const assignments = [
      enrichedAssignment(choiceQuestion('single_choice'), {
        schemaVersion: 1,
        type: 'single_choice',
        optionIds: ['option-a', 'option-b', 'option-c'],
        correctOptionId: 'option-a',
      }),
      enrichedAssignment(choiceQuestion('multiple_choice'), {
        schemaVersion: 1,
        type: 'multiple_choice',
        optionIds: ['option-a', 'option-b', 'option-c'],
        correctOptionIds: ['option-a', 'option-c'],
      }),
      enrichedAssignment(openQuestion('numeric'), {
        schemaVersion: 1,
        type: 'numeric',
        expectedNumericValue: 7,
        tolerance: 0,
      }),
      enrichedAssignment(openQuestion('exact_short_answer'), {
        schemaVersion: 1,
        type: 'exact_short_answer',
        acceptedAnswers: ['fictional answer', 'Fictional Answer'],
        caseMode: 'case_sensitive',
      }),
    ];
    for (const assignment of assignments) {
      expect(validateCoachEvent(assignment)).toEqual({ valid: true });
    }
  });

  it('requires assignment version and opaque payload together', () => {
    expect(validateCoachEvent({ ...VALID_EVENTS[7], assignmentSchemaVersion: 1 }).valid).toBe(
      false,
    );
    expect(validateCoachEvent({ ...VALID_EVENTS[7], assignmentPayload: {} }).valid).toBe(false);
    expect(
      validateCoachEvent({
        ...enrichedAssignment(choiceQuestion('single_choice'), {
          schemaVersion: 1,
          type: 'single_choice',
          optionIds: ['option-a', 'option-b', 'option-c'],
          correctOptionId: 'option-a',
        }),
        assignmentSchemaVersion: 2,
      }).valid,
    ).toBe(false);
  });

  it('keeps every enriched assignment layer closed and server-verified', () => {
    const valid = enrichedAssignment(choiceQuestion('single_choice'), {
      schemaVersion: 1,
      type: 'single_choice',
      optionIds: ['option-a', 'option-b', 'option-c'],
      correctOptionId: 'option-a',
    });
    const payload = valid.assignmentPayload as Record<string, unknown>;
    const verification = payload.verification as Record<string, unknown>;
    for (const value of [
      { ...valid, assignmentPayload: { ...payload, hiddenAnswer: 'option-a' } },
      {
        ...valid,
        assignmentPayload: {
          ...payload,
          publicQuestion: {
            ...(payload.publicQuestion as Record<string, unknown>),
            expectedAnswer: 'option-a',
          },
        },
      },
      {
        ...valid,
        assignmentPayload: {
          ...payload,
          gradingSpec: {
            ...(payload.gradingSpec as Record<string, unknown>),
            rubric: 'private rubric',
          },
        },
      },
      {
        ...valid,
        assignmentPayload: {
          ...payload,
          verification: { ...verification, status: 'candidate' },
        },
      },
      {
        ...valid,
        assignmentPayload: {
          ...payload,
          verification: {
            ...verification,
            checks: { ...VERIFIED_TRANSFER_CHECKS, answerConsistent: false },
          },
        },
      },
      {
        ...valid,
        assignmentPayload: {
          ...payload,
          verification: { ...verification, verifierReasoning: 'hidden reasoning' },
        },
      },
    ]) {
      expect(validateCoachEvent(value).valid).toBe(false);
    }
  });

  it('rejects inconsistent private answer keys and unsupported public question shapes', () => {
    expect(
      validateCoachEvent(
        enrichedAssignment(choiceQuestion('single_choice'), {
          schemaVersion: 1,
          type: 'single_choice',
          optionIds: ['option-a', 'option-b', 'option-c'],
          correctOptionId: 'missing-option',
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateCoachEvent(
        enrichedAssignment(
          {
            ...choiceQuestion('single_choice'),
            options: [
              { id: 'option-a', text: 'Same option' },
              { id: 'option-b', text: 'Same   option' },
              { id: 'option-c', text: 'Different option' },
            ],
          },
          {
            schemaVersion: 1,
            type: 'single_choice',
            optionIds: ['option-a', 'option-b', 'option-c'],
            correctOptionId: 'option-a',
          },
        ),
      ).valid,
    ).toBe(false);
    expect(
      validateCoachEvent(
        enrichedAssignment(choiceQuestion('single_choice'), {
          schemaVersion: 1,
          type: 'single_choice',
          optionIds: ['option-b', 'option-a', 'option-c'],
          correctOptionId: 'option-a',
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateCoachEvent(
        enrichedAssignment(choiceQuestion('multiple_choice'), {
          schemaVersion: 1,
          type: 'multiple_choice',
          optionIds: ['option-a', 'option-b', 'option-c'],
          correctOptionIds: ['option-a', 'option-a'],
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateCoachEvent(
        enrichedAssignment(openQuestion('numeric'), {
          schemaVersion: 1,
          type: 'numeric',
          expectedNumericValue: Number.POSITIVE_INFINITY,
          tolerance: 0,
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateCoachEvent(
        enrichedAssignment(openQuestion('numeric'), {
          schemaVersion: 1,
          type: 'numeric',
          expectedNumericValue: 7,
          tolerance: 0.1,
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateCoachEvent(
        enrichedAssignment(openQuestion('exact_short_answer'), {
          schemaVersion: 1,
          type: 'exact_short_answer',
          acceptedAnswers: [],
          caseMode: 'case_sensitive',
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateCoachEvent(
        enrichedAssignment(openQuestion('exact_short_answer'), {
          schemaVersion: 1,
          type: 'exact_short_answer',
          acceptedAnswers: ['Answer', 'answer'],
          caseMode: 'ascii_case_insensitive',
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateCoachEvent(
        enrichedAssignment(openQuestion('exact_short_answer'), {
          schemaVersion: 1,
          type: 'exact_short_answer',
          acceptedAnswers: ['fictional answer'],
          caseMode: 'semantic',
        }),
      ).valid,
    ).toBe(false);
    expect(
      validateCoachEvent(
        enrichedAssignment(
          { ...openQuestion('numeric'), type: 'essay' },
          {
            schemaVersion: 1,
            type: 'essay',
          },
        ),
      ).valid,
    ).toBe(false);
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
    expect(validateCoachEvent({ ...VALID_EVENTS[6], outcome: 'partial' }).valid).toBe(true);
    expect(validateCoachEvent({ ...VALID_EVENTS[9], outcome: 'partial' }).valid).toBe(false);
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
