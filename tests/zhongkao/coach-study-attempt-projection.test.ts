import type { RuntimeRecord } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';

import {
  buildCoachStudyAttemptProjection,
  COACH_STUDY_ATTEMPT_QUESTION_SUMMARY_MAX_LENGTH,
  deriveCoachStudyAttemptId,
  deriveCoachStudyAttemptProjectionRef,
  fingerprintCoachStudyAttempt,
} from '@/lib/server/zhongkao/coach-study-attempt-projection';
import {
  buildTransferAssignment,
  deriveTransferQuestionId,
} from '@/lib/server/zhongkao/transfer-assignment';
import type { VerifiedTransferQuestion } from '@/lib/server/zhongkao/transfer-question-private';
import {
  validateCoachEvent,
  type CoachEvent,
  type CoachEventType,
} from '@/lib/zhongkao/coach-event';

const PROFILE_ID = 'student-projection';
const SUBJECT_ID = 'math';
const DEFAULT_SESSION = 'coach-session-projection';
const ORIGINAL_KPS = ['linear-equations', 'algebra-basics'];
const TRANSFER_KPS = ['linear-equations'];

function timestamp(seq: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
}

function base(eventType: CoachEventType, seq: number, coachSessionId = DEFAULT_SESSION) {
  return {
    schemaVersion: 1 as const,
    eventId: `${coachSessionId}-event-${seq}`,
    coachSessionId,
    profileId: PROFILE_ID,
    eventType,
    createdAt: timestamp(seq),
    agentSessionId: 'agent-session-projection',
    operationId: `${coachSessionId}-operation-${seq}`,
    operationFingerprint: seq.toString(16).padStart(64, '0'),
  };
}

function started(
  seq: number,
  coachSessionId = DEFAULT_SESSION,
  options: {
    questionText?: string;
    questionSource?: { type: 'typed' } | { type: 'material'; materialId: string };
    knowledgePointIds?: readonly string[];
  } = {},
): Extract<CoachEvent, { eventType: 'coach_started' }> {
  return {
    ...base('coach_started', seq, coachSessionId),
    eventType: 'coach_started',
    subjectId: SUBJECT_ID,
    knowledgePointIds: [...(options.knowledgePointIds ?? ORIGINAL_KPS)],
    questionSource: options.questionSource ?? { type: 'typed' },
    questionText: options.questionText ?? 'Solve the fictional equation 2x = 8.',
    sourceUserMessageSeq: 1,
  };
}

function originalSubmission(
  seq: number,
  coachSessionId = DEFAULT_SESSION,
  response = `private-original-answer-${seq}`,
): Extract<CoachEvent, { eventType: 'student_attempt_submitted' }> {
  return {
    ...base('student_attempt_submitted', seq, coachSessionId),
    eventType: 'student_attempt_submitted',
    phase: 'original',
    studentResponse: response,
    sourceUserMessageSeq: seq + 1,
  };
}

function prepared(
  seq: number,
  coachSessionId = DEFAULT_SESSION,
): Extract<CoachEvent, { eventType: 'original_assessment_prepared' }> {
  return {
    ...base('original_assessment_prepared', seq, coachSessionId),
    eventType: 'original_assessment_prepared',
    assessmentVersion: 1,
    assessmentId: 'assessment-projection',
    questionFingerprint: 'a'.repeat(64),
    questionType: 'numeric',
    verificationRef: 'original-verification-projection',
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
        candidateFingerprint: 'b'.repeat(64),
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

function unavailable(
  seq: number,
  coachSessionId = DEFAULT_SESSION,
): Extract<CoachEvent, { eventType: 'original_assessment_unavailable' }> {
  return {
    ...base('original_assessment_unavailable', seq, coachSessionId),
    eventType: 'original_assessment_unavailable',
    assessmentVersion: 1,
    questionFingerprint: 'a'.repeat(64),
    reason: 'unsupported_question_type',
  };
}

function originalEvaluation(
  seq: number,
  attemptEventId: string,
  assessmentEventId: string,
  outcome: 'correct' | 'incorrect',
  coachSessionId = DEFAULT_SESSION,
): Extract<CoachEvent, { eventType: 'original_attempt_evaluated' }> {
  return {
    ...base('original_attempt_evaluated', seq, coachSessionId),
    eventType: 'original_attempt_evaluated',
    assessmentEventId,
    attemptEventId,
    outcome,
  };
}

function hintRequest(
  seq: number,
  phase: 'original' | 'transfer',
  coachSessionId = DEFAULT_SESSION,
): Extract<CoachEvent, { eventType: 'hint_requested' }> {
  return {
    ...base('hint_requested', seq, coachSessionId),
    eventType: 'hint_requested',
    phase,
    sourceUserMessageSeq: seq + 1,
  };
}

function hintIssued(
  seq: number,
  phase: 'original' | 'transfer',
  requestEventId: string,
  hintNumber: 1 | 2 | 3,
  coachSessionId = DEFAULT_SESSION,
): Extract<CoachEvent, { eventType: 'hint_issued' }> {
  return {
    ...base('hint_issued', seq, coachSessionId),
    eventType: 'hint_issued',
    phase,
    requestEventId,
    hintNumber,
    hintText: `Persisted ${phase} hint ${hintNumber}.`,
  };
}

function solutionRequest(
  seq: number,
  coachSessionId = DEFAULT_SESSION,
): Extract<CoachEvent, { eventType: 'full_solution_requested' }> {
  return {
    ...base('full_solution_requested', seq, coachSessionId),
    eventType: 'full_solution_requested',
    phase: 'original',
    sourceUserMessageSeq: seq + 1,
  };
}

function solutionReveal(
  seq: number,
  requestEventId: string,
  coachSessionId = DEFAULT_SESSION,
): Extract<CoachEvent, { eventType: 'full_solution_revealed' }> {
  return {
    ...base('full_solution_revealed', seq, coachSessionId),
    eventType: 'full_solution_revealed',
    phase: 'original',
    requestEventId,
    explanation: 'private-full-solution-explanation',
    finalAnswer: 'private-full-solution-answer',
  };
}

function evaluatedResolution(
  seq: number,
  evaluationEventId: string,
  coachSessionId = DEFAULT_SESSION,
): Extract<CoachEvent, { eventType: 'original_resolved'; resolutionKind: 'evaluated_attempt' }> {
  return {
    ...base('original_resolved', seq, coachSessionId),
    eventType: 'original_resolved',
    resolutionSchemaVersion: 3,
    resolutionKind: 'evaluated_attempt',
    evaluationEventId,
  };
}

function fullSolutionResolution(
  seq: number,
  fullSolutionEventId: string,
  coachSessionId = DEFAULT_SESSION,
): Extract<CoachEvent, { eventType: 'original_resolved'; resolutionKind: 'full_solution' }> {
  return {
    ...base('original_resolved', seq, coachSessionId),
    eventType: 'original_resolved',
    resolutionSchemaVersion: 3,
    resolutionKind: 'full_solution',
    fullSolutionEventId,
  };
}

function verifiedTransferQuestion(
  coachSessionId: string,
  originalResolvedEventId: string,
  question = 'Solve the private-safe fictional transfer equation 3x = 15.',
): VerifiedTransferQuestion {
  return {
    validationStatus: 'verified',
    validationRef: 'candidate-validation-ref',
    publicQuestion: {
      schemaVersion: 1,
      transferQuestionId: deriveTransferQuestionId({
        coachSessionId,
        originalResolvedEventId,
      }),
      type: 'numeric',
      question,
      knowledgePointIds: [...TRANSFER_KPS],
      difficulty: 'same',
    },
    gradingSpec: {
      schemaVersion: 1,
      type: 'numeric',
      expectedNumericValue: 5,
      tolerance: 0,
    },
    verification: {
      schemaVersion: 1,
      status: 'verified',
      candidateFingerprint: 'c'.repeat(64),
      verifierVersion: 1,
      checks: {
        sameKnowledgePoint: true,
        selfContained: true,
        answerConsistent: true,
        answerNotLeaked: true,
        singleAnswerOrExactSet: true,
        middleSchoolScope: true,
        meaningfullyDifferent: true,
      },
    },
  };
}

function transferAssignment(
  seq: number,
  originalResolvedEventId: string,
  coachSessionId = DEFAULT_SESSION,
  question?: string,
): Extract<CoachEvent, { eventType: 'transfer_question_assigned' }> {
  const assignment = buildTransferAssignment({
    coachSessionId,
    originalResolvedEventId,
    verifiedQuestion: verifiedTransferQuestion(coachSessionId, originalResolvedEventId, question),
  });
  return {
    ...base('transfer_question_assigned', seq, coachSessionId),
    eventType: 'transfer_question_assigned',
    originalResolvedEventId,
    transferQuestionId: assignment.publicQuestion.transferQuestionId,
    knowledgePointIds: [...assignment.publicQuestion.knowledgePointIds],
    validationRef: assignment.validationRef,
    assignmentSchemaVersion: 1,
    assignmentPayload: {
      publicQuestion: assignment.publicQuestion,
      gradingSpec: assignment.gradingSpec,
      verification: assignment.verification,
    },
  };
}

function transferSubmission(
  seq: number,
  transferQuestionId: string,
  coachSessionId = DEFAULT_SESSION,
): Extract<CoachEvent, { eventType: 'transfer_answer_submitted' }> {
  return {
    ...base('transfer_answer_submitted', seq, coachSessionId),
    eventType: 'transfer_answer_submitted',
    phase: 'transfer',
    transferQuestionId,
    studentResponse: 'private-transfer-student-answer',
    sourceUserMessageSeq: seq + 1,
  };
}

function transferEvaluation(
  seq: number,
  submission: Extract<CoachEvent, { eventType: 'transfer_answer_submitted' }>,
  outcome: 'correct' | 'incorrect',
  coachSessionId = DEFAULT_SESSION,
): Extract<CoachEvent, { eventType: 'transfer_answer_evaluated' }> {
  return {
    ...base('transfer_answer_evaluated', seq, coachSessionId),
    eventType: 'transfer_answer_evaluated',
    transferQuestionId: submission.transferQuestionId,
    submissionEventId: submission.eventId,
    outcome,
  };
}

function records(events: readonly CoachEvent[]): RuntimeRecord[] {
  for (const event of events) {
    const validation = validateCoachEvent(event);
    if (!validation.valid) throw new Error(JSON.stringify(validation));
  }
  return events.map((event, seq) => ({
    id: `record-${event.coachSessionId}-${seq}`,
    sessionId: `runtime-${event.coachSessionId}`,
    seq,
    createdAt: event.createdAt,
    payload: event,
  }));
}

function evaluatedHistory(
  input: {
    coachSessionId?: string;
    outcomes?: readonly ('correct' | 'incorrect')[];
    transferOutcome?: 'correct' | 'incorrect';
    questionText?: string;
    knowledgePointIds?: readonly string[];
  } = {},
): RuntimeRecord[] {
  const coachSessionId = input.coachSessionId ?? DEFAULT_SESSION;
  const outcomes = input.outcomes ?? ['correct'];
  const events: CoachEvent[] = [
    started(0, coachSessionId, {
      questionText: input.questionText,
      knowledgePointIds: input.knowledgePointIds,
    }),
  ];
  const attempts = outcomes.map((_, index) => originalSubmission(index + 1, coachSessionId));
  events.push(...attempts);
  const assessment = prepared(events.length, coachSessionId);
  events.push(assessment);
  const evaluations = outcomes.map((outcome, index) =>
    originalEvaluation(
      events.length + index,
      attempts[index]!.eventId,
      assessment.eventId,
      outcome,
      coachSessionId,
    ),
  );
  events.push(...evaluations);
  const referenced = [...evaluations]
    .reverse()
    .find((evaluation) => evaluation.outcome === 'correct');
  if (!referenced) throw new Error('evaluated fixture needs a correct outcome');
  const resolution = evaluatedResolution(events.length, referenced.eventId, coachSessionId);
  events.push(resolution);
  const assignment = transferAssignment(events.length, resolution.eventId, coachSessionId);
  events.push(assignment);
  const submission = transferSubmission(
    events.length,
    assignment.transferQuestionId,
    coachSessionId,
  );
  events.push(submission);
  events.push(
    transferEvaluation(
      events.length,
      submission,
      input.transferOutcome ?? 'correct',
      coachSessionId,
    ),
  );
  return records(events);
}

function fullSolutionHistory(): RuntimeRecord[] {
  const events: CoachEvent[] = [
    started(0, DEFAULT_SESSION, {
      questionText: `\uFF26ictional   equation ${'x'.repeat(700)}`,
      questionSource: { type: 'material', materialId: 'material-question-source' },
    }),
  ];
  const first = originalSubmission(1);
  const originalRequest = hintRequest(2, 'original');
  const originalHint = hintIssued(3, 'original', originalRequest.eventId, 1);
  const second = originalSubmission(4);
  const assessment = prepared(5);
  const firstEvaluation = originalEvaluation(6, first.eventId, assessment.eventId, 'incorrect');
  const secondEvaluation = originalEvaluation(7, second.eventId, assessment.eventId, 'incorrect');
  const request = solutionRequest(8);
  const reveal = solutionReveal(9, request.eventId);
  const resolution = fullSolutionResolution(10, reveal.eventId);
  const assignment = transferAssignment(
    11,
    resolution.eventId,
    DEFAULT_SESSION,
    'Transfer   question with   stable whitespace.',
  );
  events.push(
    first,
    originalRequest,
    originalHint,
    second,
    assessment,
    firstEvaluation,
    secondEvaluation,
    request,
    reveal,
    resolution,
    assignment,
  );
  for (const hintNumber of [1, 2, 3] as const) {
    const transferRequest = hintRequest(events.length, 'transfer');
    events.push(transferRequest);
    events.push(hintIssued(events.length, 'transfer', transferRequest.eventId, hintNumber));
  }
  const submission = transferSubmission(events.length, assignment.transferQuestionId);
  events.push(submission, transferEvaluation(events.length + 1, submission, 'incorrect'));
  return records(events);
}

function unassessedHistory(): RuntimeRecord[] {
  const first = originalSubmission(1);
  const unavailableFact = unavailable(2);
  const second = originalSubmission(3);
  const request = solutionRequest(4);
  const reveal = solutionReveal(5, request.eventId);
  const resolution = fullSolutionResolution(6, reveal.eventId);
  const assignment = transferAssignment(7, resolution.eventId);
  const submission = transferSubmission(8, assignment.transferQuestionId);
  return records([
    started(0, DEFAULT_SESSION, {
      questionText: 'Explain a fictional open-ended argument.',
    }),
    first,
    unavailableFact,
    second,
    request,
    reveal,
    resolution,
    assignment,
    submission,
    transferEvaluation(9, submission, 'correct'),
  ]);
}

describe('Coach StudyAttempt v2 ProjectionPlan', () => {
  it('maps evaluated original resolution and transfer from validated durable facts', () => {
    const source = evaluatedHistory({ outcomes: ['correct', 'incorrect'] });
    const plan = buildCoachStudyAttemptProjection(source);

    expect(plan.originalAttempt).toMatchObject({
      schemaVersion: 2,
      assessmentStatus: 'evaluated',
      initialOutcome: 'correct',
      finalOutcome: 'correct',
      attemptKind: 'initial',
      createdAt: source[1]!.createdAt,
      questionSourceType: 'typed',
      studentAttemptedBeforeHelp: true,
      hintsUsed: 0,
      usedKeyHint: false,
      viewedFullAnswer: false,
    });
    expect(plan.transferAttempt).toMatchObject({
      schemaVersion: 2,
      assessmentStatus: 'evaluated',
      initialOutcome: 'correct',
      finalOutcome: 'correct',
      attemptKind: 'transfer',
      questionSourceType: 'generated',
      studentAttemptedBeforeHelp: true,
      hintsUsed: 0,
      viewedFullAnswer: false,
    });
    expect(plan.originalAttempt.knowledgePointIds).toEqual([...ORIGINAL_KPS].sort());
    expect(plan.transferAttempt.knowledgePointIds).toEqual(TRANSFER_KPS);
    expect(plan.originalAttempt.id).not.toBe(plan.transferAttempt.id);
    expect(plan.projectionRef).toMatch(/^coach-projection:v1:[a-f0-9]{64}$/u);
  });

  it('uses F1 observations for full solution and keeps phase help/source facts isolated', () => {
    const plan = buildCoachStudyAttemptProjection(fullSolutionHistory());

    expect(plan.originalAttempt).toMatchObject({
      assessmentStatus: 'evaluated',
      initialOutcome: 'incorrect',
      finalOutcome: 'incorrect',
      questionSourceType: 'material',
      sourceMaterialId: 'material-question-source',
      studentAttemptedBeforeHelp: true,
      hintsUsed: 1,
      usedKeyHint: false,
      viewedFullAnswer: true,
    });
    expect([...plan.originalAttempt.questionSummary].length).toBe(
      COACH_STUDY_ATTEMPT_QUESTION_SUMMARY_MAX_LENGTH,
    );
    expect(plan.originalAttempt.questionSummary.startsWith('Fictional equation')).toBe(true);
    expect(plan.transferAttempt).toMatchObject({
      finalOutcome: 'incorrect',
      questionSummary: 'Transfer question with stable whitespace.',
      questionSourceType: 'generated',
      studentAttemptedBeforeHelp: false,
      hintsUsed: 3,
      usedKeyHint: true,
      viewedFullAnswer: false,
    });
    expect(plan.transferAttempt).not.toHaveProperty('sourceMaterialId');
    expect(plan.originalAttempt).not.toHaveProperty('sourcePage');
    expect(plan.transferAttempt).not.toHaveProperty('sourcePage');
    expect(plan.originalAttempt).not.toHaveProperty('errorType');
    expect(plan.transferAttempt).not.toHaveProperty('durationSeconds');
  });

  it('projects unsupported original as unassessed while keeping transfer evaluated', () => {
    const plan = buildCoachStudyAttemptProjection(unassessedHistory());

    expect(plan.originalAttempt).toMatchObject({
      assessmentStatus: 'unassessed',
      unassessedReason: 'unsupported_question_type',
      attemptKind: 'initial',
      viewedFullAnswer: true,
    });
    expect(plan.originalAttempt).not.toHaveProperty('initialOutcome');
    expect(plan.originalAttempt).not.toHaveProperty('finalOutcome');
    expect(plan.transferAttempt).toMatchObject({
      assessmentStatus: 'evaluated',
      initialOutcome: 'correct',
      finalOutcome: 'correct',
    });
  });

  it('fails closed for valid finalizing history without its transfer evaluation', () => {
    const source = evaluatedHistory();
    source.pop();
    expect(() => buildCoachStudyAttemptProjection(source)).toThrow(
      'STUDY_ATTEMPT_SOURCE_FACT_MISSING',
    );
  });

  it('derives stable phase/session ids, fingerprints, and projection refs', () => {
    const source = evaluatedHistory();
    const first = buildCoachStudyAttemptProjection(source);
    const replay = buildCoachStudyAttemptProjection([...source].reverse());
    expect(replay).toEqual(first);
    expect(first.originalAttempt.id).toBe(
      deriveCoachStudyAttemptId({ coachSessionId: DEFAULT_SESSION, phase: 'original' }),
    );
    expect(first.originalFingerprint).toBe(fingerprintCoachStudyAttempt(first.originalAttempt));
    expect(
      fingerprintCoachStudyAttempt({
        ...first.originalAttempt,
        knowledgePointIds: [...first.originalAttempt.knowledgePointIds].reverse(),
      }),
    ).toBe(first.originalFingerprint);
    expect(fingerprintCoachStudyAttempt({ ...first.originalAttempt, sourcePage: 1 })).not.toBe(
      first.originalFingerprint,
    );
    expect(first.projectionRef).toBe(
      deriveCoachStudyAttemptProjectionRef({
        projectionVersion: 1,
        coachSessionId: first.coachSessionId,
        originalAttemptId: first.originalAttempt.id,
        originalFingerprint: first.originalFingerprint,
        transferAttemptId: first.transferAttempt.id,
        transferFingerprint: first.transferFingerprint,
      }),
    );

    const otherSession = buildCoachStudyAttemptProjection(
      evaluatedHistory({ coachSessionId: 'coach-session-other' }),
    );
    expect(otherSession.originalAttempt.id).not.toBe(first.originalAttempt.id);
    expect(otherSession.transferAttempt.id).not.toBe(first.transferAttempt.id);
    expect(otherSession.projectionRef).not.toBe(first.projectionRef);

    const changed = buildCoachStudyAttemptProjection(
      evaluatedHistory({ transferOutcome: 'incorrect' }),
    );
    expect(changed.originalFingerprint).toBe(first.originalFingerprint);
    expect(changed.transferFingerprint).not.toBe(first.transferFingerprint);
    expect(changed.projectionRef).not.toBe(first.projectionRef);
  });

  it('emits only long-lived learning facts and no grading or response secrets', () => {
    const serialized = JSON.stringify(buildCoachStudyAttemptProjection(fullSolutionHistory()));
    expect(serialized).not.toMatch(
      /private-original-answer|private-transfer-student-answer|private-full-solution|expectedNumericValue|gradingSpec|candidateFingerprint|verification|tolerance/iu,
    );
    expect(serialized).not.toMatch(/operationId|operationFingerprint|eventId|evaluationEventId/iu);
  });
});
