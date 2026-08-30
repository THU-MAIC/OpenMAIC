import type { RuntimeRecord } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';

import type { CoachEvent, CoachPhase } from '@/lib/zhongkao/coach-event';
import {
  allowedCoachActions,
  directiveForCoachState,
  isFullSolutionAvailable,
} from '@/lib/zhongkao/coach-policy';
import { foldCoachEvents } from '@/lib/zhongkao/coach-state';

const EPOCH = Date.parse('2026-08-28T08:00:00.000Z');
const RUNTIME_SESSION_ID = 'runtime-coach-alpha';

function timestamp(seq: number): string {
  return new Date(EPOCH + seq * 1000).toISOString();
}

function base(eventType: CoachEvent['eventType'], seq: number) {
  return {
    schemaVersion: 1 as const,
    eventId: `event-${seq}`,
    coachSessionId: 'coach-alpha',
    profileId: 'student-alpha',
    eventType,
    createdAt: timestamp(seq),
    agentSessionId: 'agent-chat-alpha',
    operationId: `operation-${seq}`,
    operationFingerprint: seq.toString(16).padStart(64, '0'),
  };
}

function start(seq = 0, messageSeq = 1): CoachEvent {
  return {
    ...base('coach_started', seq),
    eventType: 'coach_started',
    sourceUserMessageSeq: messageSeq,
    subjectId: 'math',
    knowledgePointIds: ['linear-equations'],
    questionSource: { type: 'typed' },
    questionText: 'Solve the fictional equation.',
  };
}

function attempt(seq: number, messageSeq = seq + 1): CoachEvent {
  return {
    ...base('student_attempt_submitted', seq),
    eventType: 'student_attempt_submitted',
    phase: 'original',
    sourceUserMessageSeq: messageSeq,
    studentResponse: `fictional response ${seq}`,
  };
}

function hintRequest(seq: number, phase: CoachPhase, messageSeq = seq + 1): CoachEvent {
  return {
    ...base('hint_requested', seq),
    eventType: 'hint_requested',
    phase,
    sourceUserMessageSeq: messageSeq,
  };
}

function hintIssued(
  seq: number,
  phase: CoachPhase,
  requestEventId: string,
  hintNumber: 1 | 2 | 3,
): CoachEvent {
  return {
    ...base('hint_issued', seq),
    eventType: 'hint_issued',
    phase,
    requestEventId,
    hintNumber,
    hintText: `Fictional hint ${hintNumber}`,
  };
}

function solutionRequest(seq: number, messageSeq = seq + 1): CoachEvent {
  return {
    ...base('full_solution_requested', seq),
    eventType: 'full_solution_requested',
    phase: 'original',
    sourceUserMessageSeq: messageSeq,
  };
}

function solutionReveal(seq: number, requestEventId: string): CoachEvent {
  return {
    ...base('full_solution_revealed', seq),
    eventType: 'full_solution_revealed',
    phase: 'original',
    requestEventId,
    explanation: 'Fictional persisted explanation.',
  };
}

function presentationFailed(
  seq: number,
  requestEventId: string,
  presentationKind: 'hint' | 'full_solution',
  phase: CoachPhase = 'original',
): CoachEvent {
  return {
    ...base('presentation_failed', seq),
    eventType: 'presentation_failed',
    phase,
    presentationKind,
    requestEventId,
    failureCode:
      presentationKind === 'hint' ? 'HINT_GENERATION_FAILED' : 'FULL_SOLUTION_GENERATION_FAILED',
  };
}

function resolution(seq: number, attemptEventId: string): CoachEvent {
  return {
    ...base('original_resolved', seq),
    eventType: 'original_resolved',
    attemptEventId,
    outcome: 'incorrect',
  };
}

function originalAssessment(seq: number): CoachEvent {
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

function originalEvaluation(
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

function evaluatedResolution(seq: number, evaluationEventId: string): CoachEvent {
  return {
    ...base('original_resolved', seq),
    eventType: 'original_resolved',
    resolutionSchemaVersion: 2,
    resolutionKind: 'evaluated_attempt',
    evaluationEventId,
  };
}

function fullSolutionResolution(seq: number, fullSolutionEventId: string): CoachEvent {
  return {
    ...base('original_resolved', seq),
    eventType: 'original_resolved',
    resolutionSchemaVersion: 2,
    resolutionKind: 'full_solution',
    fullSolutionEventId,
  };
}

function assignment(
  seq: number,
  originalResolvedEventId: string,
  knowledgePointIds: readonly string[] = ['linear-equations'],
): CoachEvent {
  return {
    ...base('transfer_question_assigned', seq),
    eventType: 'transfer_question_assigned',
    originalResolvedEventId,
    transferQuestionId: 'transfer-alpha',
    knowledgePointIds,
    validationRef: 'verified-generator-alpha',
  };
}

function enrichedAssignment(
  seq: number,
  originalResolvedEventId: string,
  overrides: {
    outerTransferQuestionId?: string;
    publicTransferQuestionId?: string;
    outerKnowledgePointIds?: readonly string[];
    publicKnowledgePointIds?: readonly string[];
  } = {},
): CoachEvent {
  const outerTransferQuestionId = overrides.outerTransferQuestionId ?? 'transfer-alpha';
  const outerKnowledgePointIds = overrides.outerKnowledgePointIds ?? ['linear-equations'];
  return {
    ...assignment(seq, originalResolvedEventId, outerKnowledgePointIds),
    transferQuestionId: outerTransferQuestionId,
    assignmentSchemaVersion: 1,
    assignmentPayload: {
      publicQuestion: {
        schemaVersion: 1,
        transferQuestionId: overrides.publicTransferQuestionId ?? outerTransferQuestionId,
        type: 'numeric',
        question: 'Give the numeric answer for this fictional transfer question.',
        knowledgePointIds: overrides.publicKnowledgePointIds ?? outerKnowledgePointIds,
        difficulty: 'same',
      },
      gradingSpec: {
        schemaVersion: 1,
        type: 'numeric',
        expectedNumericValue: 7,
        tolerance: 0,
      },
      verification: {
        schemaVersion: 1,
        status: 'verified',
        candidateFingerprint: 'b'.repeat(64),
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
    },
  } as CoachEvent;
}

function transferSubmission(seq: number, messageSeq = seq + 1): CoachEvent {
  return {
    ...base('transfer_answer_submitted', seq),
    eventType: 'transfer_answer_submitted',
    phase: 'transfer',
    transferQuestionId: 'transfer-alpha',
    sourceUserMessageSeq: messageSeq,
    studentResponse: 'fictional transfer response',
  };
}

function evaluation(seq: number, submissionEventId: string): CoachEvent {
  return {
    ...base('transfer_answer_evaluated', seq),
    eventType: 'transfer_answer_evaluated',
    transferQuestionId: 'transfer-alpha',
    submissionEventId,
    outcome: 'correct',
  };
}

function projection(seq: number, evaluationEventId: string): CoachEvent {
  return {
    ...base('study_attempts_projected', seq),
    eventType: 'study_attempts_projected',
    evaluationEventId,
    projectionRef: 'projection-alpha',
    projectionVersion: 1,
  };
}

function abandoned(seq: number, messageSeq = seq + 1): CoachEvent {
  return {
    ...base('problem_abandoned', seq),
    eventType: 'problem_abandoned',
    sourceUserMessageSeq: messageSeq,
  };
}

function record(seq: number, event: CoachEvent, sessionId = RUNTIME_SESSION_ID): RuntimeRecord {
  return { id: `record-${seq}`, sessionId, seq, createdAt: timestamp(seq), payload: event };
}

function records(events: readonly CoachEvent[]): RuntimeRecord[] {
  return events.map((event, seq) => record(seq, event));
}

function transferReadyEvents(): CoachEvent[] {
  const originalAttempt = attempt(1, 2);
  const resolved = resolution(2, originalAttempt.eventId);
  return [start(), originalAttempt, resolved, assignment(3, resolved.eventId)];
}

function completedEvents(): CoachEvent[] {
  const events = transferReadyEvents();
  const submitted = transferSubmission(4, 5);
  const evaluated = evaluation(5, submitted.eventId);
  return [...events, submitted, evaluated, projection(6, evaluated.eventId)];
}

describe('foldCoachEvents strict deterministic projection', () => {
  it('starts with isolated original and transfer phase state', () => {
    const state = foldCoachEvents(records([start()]));
    expect(state).toMatchObject({ status: 'awaiting_student_attempt', revision: 0 });
    expect(state.original).toMatchObject({
      attemptCount: 0,
      hintsIssued: 0,
      viewedFullAnswer: false,
    });
    expect(state.transfer).toMatchObject({
      assigned: false,
      attemptCount: 0,
      hintsIssued: 0,
      viewedFullAnswer: false,
    });
  });

  it('sorts by RuntimeStore seq and uses the legal tail as revision', () => {
    const ordered = records([start(), attempt(1), attempt(2)]);
    expect(foldCoachEvents(ordered.toReversed())).toEqual(foldCoachEvents(ordered));
    expect(foldCoachEvents(ordered).revision).toBe(2);
  });

  it('requires seq zero and a strictly contiguous sequence', () => {
    expect(() => foldCoachEvents([record(1, start())])).toThrow('COACH_EVENT_CONFLICT');
    expect(() => foldCoachEvents([record(0, start()), record(2, attempt(1))])).toThrow(
      'COACH_EVENT_CONFLICT',
    );
  });

  it('rejects duplicate seq, eventId, and operationId even for identical facts', () => {
    const first = start();
    expect(() => foldCoachEvents([record(0, first), record(0, attempt(1))])).toThrow(
      'COACH_EVENT_CONFLICT',
    );
    expect(() => foldCoachEvents([record(0, first), record(1, first)])).toThrow(
      'COACH_EVENT_CONFLICT',
    );
    expect(() =>
      foldCoachEvents(records([first, { ...attempt(1), operationId: first.operationId }])),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('rejects a non-start first event, second start, and mixed partitions', () => {
    expect(() => foldCoachEvents(records([attempt(0)]))).toThrow('COACH_EVENT_CONFLICT');
    expect(() => foldCoachEvents(records([start(), start(1, 2)]))).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      foldCoachEvents([record(0, start()), record(1, attempt(1), 'other-runtime')]),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      foldCoachEvents(records([start(), { ...attempt(1), profileId: 'student-beta' }])),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('unlocks only from original attempts and actually issued original hints', () => {
    const one = foldCoachEvents(records([start(), attempt(1)]));
    expect(one.original.fullSolutionAvailable).toBe(false);
    expect(isFullSolutionAvailable(one.original)).toBe(false);
    const two = foldCoachEvents(records([start(), attempt(1), attempt(2)]));
    expect(two.original.fullSolutionAvailable).toBe(true);
    expect(two.status).toBe('solution_available');
  });

  it('keeps a hint pending until the exact causal request is issued', () => {
    const requested = hintRequest(1, 'original', 2);
    const pending = foldCoachEvents(records([start(), requested]));
    expect(pending.original.pendingHintRequestEventId).toBe(requested.eventId);
    expect(pending.original.hintsIssued).toBe(0);
    expect(() =>
      foldCoachEvents(records([start(), requested, hintIssued(2, 'original', 'wrong-request', 1)])),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('clears only the exact failed hint request without advancing hint state', () => {
    const requested = hintRequest(1, 'original', 2);
    const failed = presentationFailed(2, requested.eventId, 'hint');
    const next = hintRequest(3, 'original', 3);
    const state = foldCoachEvents(records([start(), requested, failed, next]));
    expect(state.original).toMatchObject({
      hintRequestEventIds: [requested.eventId, next.eventId],
      pendingHintRequestEventId: next.eventId,
      hintsIssued: 0,
      keyHintUsed: false,
    });
    expect(() =>
      foldCoachEvents(
        records([start(), requested, presentationFailed(2, 'wrong-request', 'hint')]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('isolates original and transfer hint counts and key-hint thresholds', () => {
    const events: CoachEvent[] = [start(), attempt(1, 2)];
    for (let hint = 1; hint <= 3; hint += 1) {
      const request = hintRequest(events.length, 'original', 10 + hint);
      events.push(
        request,
        hintIssued(events.length + 1, 'original', request.eventId, hint as 1 | 2 | 3),
      );
    }
    const resolved = resolution(events.length, events[1]!.eventId);
    events.push(resolved, assignment(events.length + 1, resolved.eventId));
    for (let hint = 1; hint <= 3; hint += 1) {
      const request = hintRequest(events.length, 'transfer', 20 + hint);
      events.push(
        request,
        hintIssued(events.length + 1, 'transfer', request.eventId, hint as 1 | 2 | 3),
      );
    }
    const state = foldCoachEvents(records(events));
    expect(state.original).toMatchObject({ hintsIssued: 3, keyHintUsed: true });
    expect(state.transfer).toMatchObject({ hintsIssued: 3, keyHintUsed: true });
  });

  it('does not let transfer hints unlock the original solution', () => {
    const events = transferReadyEvents();
    const request = hintRequest(4, 'transfer', 7);
    events.push(request, hintIssued(5, 'transfer', request.eventId, 1));
    const state = foldCoachEvents(records(events));
    expect(state.original.hintsIssued).toBe(0);
    expect(state.transfer.hintsIssued).toBe(1);
    expect(state.original.fullSolutionAvailable).toBe(false);
  });

  it('records an early solution request without creating a pending reveal', () => {
    const early = solutionRequest(1, 2);
    const state = foldCoachEvents(records([start(), early, attempt(2, 3), attempt(3, 4)]));
    expect(state.original.fullSolutionRequestEventIds).toEqual([early.eventId]);
    expect(state.original.fullSolutionAvailable).toBe(true);
    expect(state.original.pendingFullSolutionRequestEventId).toBeUndefined();
    expect(directiveForCoachState(state)).toBe('FULL_SOLUTION_AVAILABLE');
  });

  it('requires a new unlocked request and consumes it exactly once', () => {
    const early = solutionRequest(1, 2);
    const unlocked = solutionRequest(4, 5);
    const events = [start(), early, attempt(2, 3), attempt(3, 4), unlocked];
    const pending = foldCoachEvents(records(events));
    expect(pending.original.pendingFullSolutionRequestEventId).toBe(unlocked.eventId);
    expect(directiveForCoachState(pending)).toBe('GENERATE_FULL_SOLUTION');
    const revealed = foldCoachEvents(records([...events, solutionReveal(5, unlocked.eventId)]));
    expect(revealed.original.viewedFullAnswer).toBe(true);
    expect(revealed.original.pendingFullSolutionRequestEventId).toBeUndefined();
    expect(revealed.transfer.viewedFullAnswer).toBe(false);
  });

  it('clears a failed unlocked solution request without marking the answer viewed', () => {
    const first = attempt(1, 2);
    const second = attempt(2, 3);
    const requested = solutionRequest(3, 4);
    const failed = presentationFailed(4, requested.eventId, 'full_solution');
    const next = solutionRequest(5, 5);
    const state = foldCoachEvents(records([start(), first, second, requested, failed, next]));
    expect(state.original.viewedFullAnswer).toBe(false);
    expect(state.original.pendingFullSolutionRequestEventId).toBe(next.eventId);
    expect(state.original.fullSolutionRequestEventIds).toEqual([requested.eventId, next.eventId]);
    expect(() =>
      foldCoachEvents(
        records([
          start(),
          first,
          second,
          requested,
          presentationFailed(4, 'wrong-request', 'full_solution'),
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('rejects reveal without the current unlocked pending request', () => {
    const early = solutionRequest(1, 2);
    expect(() =>
      foldCoachEvents(
        records([start(), early, attempt(2, 3), attempt(3, 4), solutionReveal(4, early.eventId)]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('requires original assessment and attempt references to exist in the same session', () => {
    const submitted = attempt(1, 2);
    const prepared = originalAssessment(2);
    const evaluated = originalEvaluation(3, prepared.eventId, submitted.eventId, 'incorrect');
    const state = foldCoachEvents(records([start(), submitted, prepared, evaluated]));
    expect(state.original).toMatchObject({
      assessmentEventId: prepared.eventId,
      evaluationEventIds: [evaluated.eventId],
      evaluatedAttemptEventIds: [submitted.eventId],
    });

    expect(() =>
      foldCoachEvents(
        records([
          start(),
          submitted,
          originalEvaluation(2, 'missing-assessment', submitted.eventId, 'incorrect'),
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      foldCoachEvents(
        records([
          start(),
          originalAssessment(1),
          originalEvaluation(2, 'event-1', 'missing-attempt', 'incorrect'),
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      foldCoachEvents(
        records([
          start(),
          submitted,
          { ...prepared, coachSessionId: 'coach-beta' } as CoachEvent,
          evaluated,
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      foldCoachEvents(
        records([
          start(),
          { ...submitted, coachSessionId: 'coach-beta' } as CoachEvent,
          prepared,
          evaluated,
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('evaluates original attempts exactly once and in submission order', () => {
    const first = attempt(1, 2);
    const second = attempt(2, 3);
    const prepared = originalAssessment(3);
    const firstEvaluation = originalEvaluation(4, prepared.eventId, first.eventId, 'incorrect');
    const secondEvaluation = originalEvaluation(5, prepared.eventId, second.eventId, 'incorrect');

    expect(() =>
      foldCoachEvents(
        records([
          start(),
          first,
          second,
          prepared,
          originalEvaluation(4, prepared.eventId, second.eventId, 'incorrect'),
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      foldCoachEvents(
        records([
          start(),
          first,
          second,
          prepared,
          firstEvaluation,
          originalEvaluation(5, prepared.eventId, first.eventId, 'incorrect'),
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      foldCoachEvents(records([start(), first, second, prepared, originalAssessment(4)])),
    ).toThrow('COACH_EVENT_CONFLICT');

    const state = foldCoachEvents(
      records([start(), first, second, prepared, firstEvaluation, secondEvaluation]),
    );
    expect(state.original.evaluationEventIds).toEqual([
      firstEvaluation.eventId,
      secondEvaluation.eventId,
    ]);
    expect(state.original.evaluatedAttemptEventIds).toEqual([first.eventId, second.eventId]);
  });

  it('allows v2 evaluated resolution only from the current correct evaluation', () => {
    const submitted = attempt(1, 2);
    const prepared = originalAssessment(2);
    const correct = originalEvaluation(3, prepared.eventId, submitted.eventId, 'correct');
    const resolved = evaluatedResolution(4, correct.eventId);
    const state = foldCoachEvents(records([start(), submitted, prepared, correct, resolved]));
    expect(state.original).toMatchObject({
      resolved: true,
      resolutionEventId: resolved.eventId,
      resolutionKind: 'evaluated_attempt',
      correctEvaluationEventId: correct.eventId,
      outcome: 'correct',
    });

    const incorrect = originalEvaluation(3, prepared.eventId, submitted.eventId, 'incorrect');
    expect(() =>
      foldCoachEvents(
        records([
          start(),
          submitted,
          prepared,
          incorrect,
          evaluatedResolution(4, incorrect.eventId),
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      foldCoachEvents(
        records([start(), submitted, prepared, evaluatedResolution(3, 'missing-evaluation')]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('finishes an existing evaluation backlog before the last outcome decides resolution', () => {
    const first = attempt(1, 2);
    const second = attempt(2, 3);
    const prepared = originalAssessment(3);
    const firstCorrect = originalEvaluation(4, prepared.eventId, first.eventId, 'correct');
    const secondIncorrect = originalEvaluation(5, prepared.eventId, second.eventId, 'incorrect');

    const pendingAfterFirst = foldCoachEvents(
      records([start(), first, second, prepared, firstCorrect]),
    );
    expect(pendingAfterFirst.original.correctEvaluationEventId).toBe(firstCorrect.eventId);
    const exhaustedByIncorrect = foldCoachEvents(
      records([start(), first, second, prepared, firstCorrect, secondIncorrect]),
    );
    expect(exhaustedByIncorrect.original.evaluatedAttemptEventIds).toEqual([
      first.eventId,
      second.eventId,
    ]);
    expect(exhaustedByIncorrect.original.correctEvaluationEventId).toBeUndefined();
    expect(() =>
      foldCoachEvents(
        records([
          start(),
          first,
          second,
          prepared,
          firstCorrect,
          secondIncorrect,
          evaluatedResolution(6, firstCorrect.eventId),
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');

    const firstIncorrect = originalEvaluation(4, prepared.eventId, first.eventId, 'incorrect');
    const secondCorrect = originalEvaluation(5, prepared.eventId, second.eventId, 'correct');
    const ready = foldCoachEvents(
      records([start(), first, second, prepared, firstIncorrect, secondCorrect]),
    );
    expect(ready.original.correctEvaluationEventId).toBe(secondCorrect.eventId);
    const resolved = evaluatedResolution(6, secondCorrect.eventId);
    expect(
      foldCoachEvents(
        records([start(), first, second, prepared, firstIncorrect, secondCorrect, resolved]),
      ).original,
    ).toMatchObject({
      resolved: true,
      resolutionKind: 'evaluated_attempt',
      outcome: 'correct',
      correctEvaluationEventId: secondCorrect.eventId,
    });
  });

  it('requires original resolution to cite a real original attempt', () => {
    expect(() => foldCoachEvents(records([start(), resolution(1, 'missing-attempt')]))).toThrow(
      'COACH_EVENT_CONFLICT',
    );
    const submitted = transferSubmission(4, 5);
    const events = [...transferReadyEvents(), submitted, resolution(5, submitted.eventId)];
    expect(() => foldCoachEvents(records(events))).toThrow('COACH_EVENT_CONFLICT');
  });

  it('folds a v2 full-solution resolution without inventing an outcome', () => {
    const first = attempt(1, 2);
    const second = attempt(2, 3);
    const requested = solutionRequest(3, 4);
    const revealed = solutionReveal(4, requested.eventId);
    const resolved = fullSolutionResolution(5, revealed.eventId);
    const state = foldCoachEvents(records([start(), first, second, requested, revealed, resolved]));
    expect(state.original).toMatchObject({
      resolved: true,
      viewedFullAnswer: true,
      resolutionEventId: resolved.eventId,
      resolutionKind: 'full_solution',
    });
    expect(state.original).not.toHaveProperty('outcome');
    expect(() =>
      foldCoachEvents(
        records([
          start(),
          first,
          second,
          requested,
          revealed,
          fullSolutionResolution(5, 'missing-reveal'),
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('rejects resolution while a prepared assessment still has unevaluated attempts', () => {
    const first = attempt(1, 2);
    const second = attempt(2, 3);
    const prepared = originalAssessment(3);
    const requested = solutionRequest(4, 4);
    const revealed = solutionReveal(5, requested.eventId);
    const resolved = fullSolutionResolution(6, revealed.eventId);

    expect(() =>
      foldCoachEvents(records([start(), first, second, prepared, requested, revealed, resolved])),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('keeps legacy outcome resolution readable', () => {
    const submitted = attempt(1, 2);
    const resolved = resolution(2, submitted.eventId);
    expect(foldCoachEvents(records([start(), submitted, resolved])).original).toMatchObject({
      resolved: true,
      resolutionEventId: resolved.eventId,
      resolutionKind: 'legacy_outcome',
      outcome: 'incorrect',
    });
  });

  it('keeps legacy full-solution resolution readable without inventing an outcome', () => {
    const first = attempt(1, 2);
    const second = attempt(2, 3);
    const requested = solutionRequest(3, 4);
    const revealed = solutionReveal(4, requested.eventId);
    const resolved: CoachEvent = {
      ...base('original_resolved', 5),
      eventType: 'original_resolved',
      attemptEventId: second.eventId,
      fullSolutionEventId: revealed.eventId,
    };
    const state = foldCoachEvents(records([start(), first, second, requested, revealed, resolved]));
    expect(state.original).toMatchObject({
      resolved: true,
      viewedFullAnswer: true,
      resolutionEventId: resolved.eventId,
      resolutionKind: 'legacy_full_solution',
    });
    expect(state.original).not.toHaveProperty('outcome');
    expect(() =>
      foldCoachEvents(
        records([
          start(),
          first,
          second,
          requested,
          revealed,
          { ...resolved, fullSolutionEventId: 'missing-reveal' } as CoachEvent,
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('requires assignment to cite the authoritative resolution', () => {
    const originalAttempt = attempt(1, 2);
    const resolved = resolution(2, originalAttempt.eventId);
    expect(() =>
      foldCoachEvents(
        records([start(), originalAttempt, resolved, assignment(3, 'wrong-resolution')]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('allows a non-empty transfer knowledge-point subset but rejects additions', () => {
    const originalAttempt = attempt(1, 2);
    const resolved = resolution(2, originalAttempt.eventId);
    const started = {
      ...start(),
      knowledgePointIds: ['linear-equations', 'equation-transformations'],
    } as CoachEvent;
    const subset = assignment(3, resolved.eventId, ['linear-equations']);
    expect(
      foldCoachEvents(records([started, originalAttempt, resolved, subset])).transfer.assigned,
    ).toBe(true);
    expect(() =>
      foldCoachEvents(
        records([
          started,
          originalAttempt,
          resolved,
          assignment(3, resolved.eventId, ['linear-equations', 'quadratic-equations']),
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('binds enriched public assignment ids and knowledge points to the outer event facts', () => {
    const originalAttempt = attempt(1, 2);
    const resolved = resolution(2, originalAttempt.eventId);
    expect(
      foldCoachEvents(
        records([start(), originalAttempt, resolved, enrichedAssignment(3, resolved.eventId)]),
      ).transfer.assigned,
    ).toBe(true);
    expect(() =>
      foldCoachEvents(
        records([
          start(),
          originalAttempt,
          resolved,
          enrichedAssignment(3, resolved.eventId, {
            publicTransferQuestionId: 'other-transfer',
          }),
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      foldCoachEvents(
        records([
          start(),
          originalAttempt,
          resolved,
          enrichedAssignment(3, resolved.eventId, {
            publicKnowledgePointIds: ['quadratic-equations'],
          }),
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('requires exact transfer question and submission references for evaluation', () => {
    const submitted = transferSubmission(4, 5);
    expect(() =>
      foldCoachEvents(
        records([
          ...transferReadyEvents(),
          submitted,
          {
            ...evaluation(5, submitted.eventId),
            transferQuestionId: 'other-transfer',
          } as CoachEvent,
        ]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
    expect(() =>
      foldCoachEvents(
        records([...transferReadyEvents(), submitted, evaluation(5, 'missing-submission')]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('requires projection to cite the authoritative evaluation', () => {
    const submitted = transferSubmission(4, 5);
    const evaluated = evaluation(5, submitted.eventId);
    expect(() =>
      foldCoachEvents(
        records([...transferReadyEvents(), submitted, evaluated, projection(6, 'wrong-eval')]),
      ),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('completes only after evaluation and projection', () => {
    const submitted = foldCoachEvents(records(completedEvents().slice(0, 5)));
    expect(submitted.status).toBe('finalizing');
    expect(allowedCoachActions(submitted)).toEqual(['get_state']);
    expect(directiveForCoachState(submitted)).toBe('EVALUATE_TRANSFER_ANSWER');
    const evaluated = foldCoachEvents(records(completedEvents().slice(0, 6)));
    expect(evaluated.status).toBe('finalizing');
    expect(allowedCoachActions(evaluated)).toEqual(['get_state']);
    expect(directiveForCoachState(evaluated)).toBe('PROJECT_STUDY_ATTEMPTS');
    const completed = foldCoachEvents(records(completedEvents()));
    expect(completed.status).toBe('completed');
    expect(completed.studyAttemptsProjected).toBe(true);
  });

  it('allows one transfer submission and never exposes a transfer full answer', () => {
    const submitted = transferSubmission(4, 5);
    const state = foldCoachEvents(records([...transferReadyEvents(), submitted]));
    expect(state.transfer).toMatchObject({ attemptCount: 1, viewedFullAnswer: false });
    expect(() =>
      foldCoachEvents(records([...transferReadyEvents(), submitted, transferSubmission(5, 6)])),
    ).toThrow('COACH_EVENT_CONFLICT');
  });

  it('rejects reusing one attempt message reference across phases', () => {
    const events = transferReadyEvents();
    events.push(transferSubmission(4, 2));
    expect(() => foldCoachEvents(records(events))).toThrow('COACH_EVENT_CONFLICT');
  });

  it('keeps abandonment terminal', () => {
    expect(foldCoachEvents(records([start(), abandoned(1, 2)])).status).toBe('abandoned');
    expect(() => foldCoachEvents(records([start(), abandoned(1, 2), attempt(2, 3)]))).toThrow(
      'COACH_EVENT_CONFLICT',
    );
  });
});
