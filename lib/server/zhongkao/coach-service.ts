import type { RuntimeRecord } from '@openmaic/dsl';

import { CoachError, type CoachErrorCode } from '@/lib/zhongkao/coach-errors';
import {
  COACH_PROJECTION_VERSION,
  COACH_FINAL_ANSWER_MAX_LENGTH,
  COACH_HINT_TEXT_MAX_LENGTH,
  COACH_SOLUTION_EXPLANATION_MAX_LENGTH,
  COACH_TRUSTED_MESSAGE_MAX_LENGTH,
  assertCoachEvent,
  isCoachPresentationFailureCodeForKind,
  type CoachEvent,
  type CoachOutcome,
  type CoachPhase,
  type CoachStartedEvent,
  type CoachPresentationFailureCode,
  type CoachPresentationKind,
  type CoachQuestionSource,
  type HintRequestedEvent,
  type TransferAnswerSubmittedEvent,
} from '@/lib/zhongkao/coach-event';
import { allowedCoachActions, type CoachModelAction } from '@/lib/zhongkao/coach-policy';
import { loadStudentProfile } from '@/lib/zhongkao/runtime';
import {
  finishValidation,
  validateIdentifier,
  type DomainValidationIssue,
} from '@/lib/zhongkao/validation';

import {
  appendCoachRuntimeEvent,
  createCoachOperationFingerprint,
  deriveCoachCausalOperationId,
  deriveCoachEventId,
  deriveCoachModelOperationId,
  deriveCoachProjectionRef,
  hashCoachMessageText,
  loadCoachRuntime,
  startCoachRuntime,
  type CoachRuntimeDeps,
  type CoachRuntimeSnapshot,
  type CoachRuntimeWriteResult,
} from './coach-runtime';
import { resolveZhongkaoLearnerKeyFromOwnerId } from './learner-identity';
import { evaluateTransferAnswer } from './transfer-answer-evaluator';
import {
  buildOriginalAssessmentPreparedFacts,
  extractVerifiedOriginalAssessment,
  type VerifiedOriginalAssessment,
} from './original-assessment-private';
import {
  TRANSFER_ASSIGNMENT_SCHEMA_VERSION,
  buildTransferAssignment,
  extractVerifiedTransferAssignment,
} from './transfer-assignment';
import type { VerifiedTransferQuestion } from './transfer-question-private';

export interface TrustedCoachUserMessage {
  seq: number;
  text: string;
}

export interface CoachServiceDeps extends CoachRuntimeDeps {
  agentSessionId: string;
}

export interface CoachActionResult extends CoachRuntimeWriteResult {
  code?: CoachErrorCode;
}

export interface CoachContinuationInput {
  profileId: string;
  coachSessionId: string;
  expectedRevision: number;
}

type OriginalResolutionFacts =
  | { attemptEventId: string; outcome: CoachOutcome; fullSolutionEventId?: never }
  | { attemptEventId: string; fullSolutionEventId: string; outcome?: never };

function assertIdentifier(value: string): void {
  const errors: DomainValidationIssue[] = [];
  validateIdentifier(value, '/id', errors);
  if (!finishValidation(errors).valid) throw new CoachError('COACH_INPUT_INVALID');
}

function assertOutcome(value: CoachOutcome): void {
  if (value !== 'correct' && value !== 'partial' && value !== 'incorrect') {
    throw new CoachError('COACH_INPUT_INVALID');
  }
}

function assertContinuation(input: CoachContinuationInput): void {
  assertIdentifier(input.profileId);
  assertIdentifier(input.coachSessionId);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new CoachError('COACH_INPUT_INVALID');
  }
}

function normalizedMessage(message: TrustedCoachUserMessage): TrustedCoachUserMessage {
  if (!Number.isSafeInteger(message.seq) || message.seq < 1 || typeof message.text !== 'string') {
    throw new CoachError('COACH_INPUT_INVALID');
  }
  const text = message.text.trim();
  if (text.length === 0 || text.length > COACH_TRUSTED_MESSAGE_MAX_LENGTH) {
    throw new CoachError('COACH_INPUT_INVALID');
  }
  return { seq: message.seq, text };
}

function normalizedPresentationText(value: string, maxLength: number): string {
  if (typeof value !== 'string') throw new CoachError('COACH_INPUT_INVALID');
  const text = value.trim();
  if (!text || text.length > maxLength) throw new CoachError('COACH_INPUT_INVALID');
  return text;
}

function normalizeKnowledgePointIds(ids: readonly string[]): string[] {
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 32 ||
    new Set(ids).size !== ids.length
  ) {
    throw new CoachError('COACH_INPUT_INVALID');
  }
  ids.forEach(assertIdentifier);
  return [...ids].sort();
}

function eventFromRecord(record: RuntimeRecord): CoachEvent {
  assertCoachEvent(record.payload);
  return record.payload;
}

function eventById(snapshot: CoachRuntimeSnapshot, eventId: string): CoachEvent | undefined {
  return snapshot.records.map(eventFromRecord).find((event) => event.eventId === eventId);
}

function requireCoachStart(snapshot: CoachRuntimeSnapshot): CoachStartedEvent {
  const event = snapshot.records
    .map(eventFromRecord)
    .find((candidate) => candidate.eventType === 'coach_started');
  if (!event || event.eventType !== 'coach_started') throw new CoachError('COACH_EVENT_CONFLICT');
  return event;
}

function operationEvent(
  snapshot: CoachRuntimeSnapshot,
  operationId: string,
): CoachEvent | undefined {
  return snapshot.records.map(eventFromRecord).find((event) => event.operationId === operationId);
}

function messageRefAlreadyAttempted(
  snapshot: CoachRuntimeSnapshot,
  agentSessionId: string,
  seq: number,
): boolean {
  return [
    ...snapshot.state.original.attemptMessageRefs,
    ...snapshot.state.transfer.attemptMessageRefs,
  ].some((ref) => ref.agentSessionId === agentSessionId && ref.userMessageSeq === seq);
}

function baseEvent(
  deps: CoachServiceDeps,
  input: Pick<CoachContinuationInput, 'profileId' | 'coachSessionId'>,
  metadata: {
    eventId: string;
    createdAt: string;
    operationId: string;
    operationFingerprint: string;
  },
) {
  return {
    schemaVersion: 1 as const,
    eventId: metadata.eventId,
    coachSessionId: input.coachSessionId,
    profileId: input.profileId,
    createdAt: metadata.createdAt,
    agentSessionId: deps.agentSessionId,
    operationId: metadata.operationId,
    operationFingerprint: metadata.operationFingerprint,
  };
}

function requireModelAction(snapshot: CoachRuntimeSnapshot, action: CoachModelAction): void {
  if (!allowedCoachActions(snapshot.state).includes(action)) {
    throw new CoachError('COACH_ACTION_NOT_ALLOWED');
  }
}

function modelOperationId(
  deps: CoachServiceDeps,
  input: Pick<CoachContinuationInput, 'profileId' | 'coachSessionId'>,
  message: TrustedCoachUserMessage,
  action: CoachModelAction,
): string {
  return deriveCoachModelOperationId({
    learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId),
    profileId: input.profileId,
    coachSessionId: input.coachSessionId,
    agentSessionId: deps.agentSessionId,
    sourceUserMessageSeq: message.seq,
    action,
  });
}

function modelMessageRef(deps: CoachServiceDeps, message: TrustedCoachUserMessage) {
  return { agentSessionId: deps.agentSessionId, userMessageSeq: message.seq };
}

function activeHintPhase(snapshot: CoachRuntimeSnapshot): CoachPhase {
  return snapshot.state.transfer.assigned ? 'transfer' : 'original';
}

function phaseForHintOperation(snapshot: CoachRuntimeSnapshot, operationId: string): CoachPhase {
  const existing = operationEvent(snapshot, operationId);
  if (existing) {
    if (existing.eventType !== 'hint_requested') throw new CoachError('COACH_EVENT_CONFLICT');
    return existing.phase;
  }
  return activeHintPhase(snapshot);
}

export async function startCoachProblem(
  deps: CoachServiceDeps,
  input: {
    profileId: string;
    subjectId: string;
    knowledgePointIds: readonly string[];
    questionSource: CoachQuestionSource;
    message: TrustedCoachUserMessage;
  },
): Promise<CoachActionResult> {
  assertIdentifier(input.profileId);
  assertIdentifier(input.subjectId);
  assertIdentifier(deps.agentSessionId);
  const knowledgePointIds = normalizeKnowledgePointIds(input.knowledgePointIds);
  if (input.questionSource.type === 'material') assertIdentifier(input.questionSource.materialId);
  const message = normalizedMessage(input.message);
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(deps.ownerId);
  const profile = await loadStudentProfile(input.profileId, { store: deps.store, learnerKey });
  if (!profile) throw new CoachError('COACH_PROFILE_NOT_FOUND');

  return startCoachRuntime(deps, {
    profileId: input.profileId,
    subjectId: input.subjectId,
    knowledgePointIds,
    questionSource: { ...input.questionSource },
    questionText: message.text,
    agentSessionId: deps.agentSessionId,
    sourceUserMessageSeq: message.seq,
  });
}

export async function getCoachProblemState(
  deps: CoachServiceDeps,
  profileId: string,
  coachSessionId: string,
): Promise<CoachRuntimeSnapshot> {
  assertIdentifier(profileId);
  assertIdentifier(coachSessionId);
  return loadCoachRuntime(deps, profileId, coachSessionId);
}

export async function submitCoachAttempt(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & { message: TrustedCoachUserMessage },
): Promise<CoachActionResult> {
  assertContinuation(input);
  const message = normalizedMessage(input.message);
  const operationId = modelOperationId(deps, input, message, 'submit_attempt');
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'submit_attempt',
    coachSessionId: input.coachSessionId,
    phase: 'original',
    trustedMessageRef: modelMessageRef(deps, message),
    studentResponseHash: hashCoachMessageText(message.text),
  });
  return appendCoachRuntimeEvent(deps, {
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      requireModelAction(snapshot, 'submit_attempt');
      if (messageRefAlreadyAttempted(snapshot, deps.agentSessionId, message.seq)) {
        throw new CoachError('COACH_MESSAGE_ALREADY_COUNTED');
      }
      return {
        ...baseEvent(deps, input, metadata),
        eventType: 'student_attempt_submitted',
        phase: 'original',
        sourceUserMessageSeq: message.seq,
        studentResponse: message.text,
      };
    },
  });
}

export async function requestCoachHint(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & {
    message: TrustedCoachUserMessage;
    requiredPhase?: CoachPhase;
  },
): Promise<CoachActionResult> {
  assertContinuation(input);
  if (
    input.requiredPhase !== undefined &&
    input.requiredPhase !== 'original' &&
    input.requiredPhase !== 'transfer'
  ) {
    throw new CoachError('COACH_INPUT_INVALID');
  }
  const message = normalizedMessage(input.message);
  const operationId = modelOperationId(deps, input, message, 'request_hint');
  const observed = await loadCoachRuntime(deps, input.profileId, input.coachSessionId);
  const phase = phaseForHintOperation(observed, operationId);
  if (input.requiredPhase !== undefined && phase !== input.requiredPhase) {
    throw new CoachError('COACH_ACTION_NOT_ALLOWED');
  }
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'request_hint',
    coachSessionId: input.coachSessionId,
    phase,
    trustedMessageRef: modelMessageRef(deps, message),
  });
  return appendCoachRuntimeEvent(deps, {
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      const target = phase === 'original' ? snapshot.state.original : snapshot.state.transfer;
      if (target.hintsIssued >= 3) throw new CoachError('HINT_LIMIT_REACHED');
      if (target.pendingHintRequestEventId) throw new CoachError('HINT_GENERATION_PENDING');
      requireModelAction(snapshot, 'request_hint');
      return {
        ...baseEvent(deps, input, metadata),
        eventType: 'hint_requested',
        phase,
        sourceUserMessageSeq: message.seq,
      };
    },
  });
}

export async function requestCoachFullSolution(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & { message: TrustedCoachUserMessage },
): Promise<CoachActionResult> {
  assertContinuation(input);
  const message = normalizedMessage(input.message);
  const operationId = modelOperationId(deps, input, message, 'request_full_solution');
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'request_full_solution',
    coachSessionId: input.coachSessionId,
    phase: 'original',
    trustedMessageRef: modelMessageRef(deps, message),
  });
  const result = await appendCoachRuntimeEvent(deps, {
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      requireModelAction(snapshot, 'request_full_solution');
      return {
        ...baseEvent(deps, input, metadata),
        eventType: 'full_solution_requested',
        phase: 'original',
        sourceUserMessageSeq: message.seq,
      };
    },
  });
  const requestEventId = deriveCoachEventId(operationId);
  return result.snapshot.state.original.pendingFullSolutionRequestEventId === requestEventId
    ? result
    : { ...result, code: 'FULL_SOLUTION_LOCKED' };
}

export async function recordCoachPresentationFailure(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & {
    phase: CoachPhase;
    presentationKind: CoachPresentationKind;
    requestEventId: string;
    failureCode: CoachPresentationFailureCode;
  },
): Promise<CoachActionResult> {
  assertContinuation(input);
  assertIdentifier(input.requestEventId);
  if (!isCoachPresentationFailureCodeForKind(input.presentationKind, input.failureCode)) {
    throw new CoachError('COACH_INPUT_INVALID');
  }
  const operationId = deriveCoachCausalOperationId({
    coachSessionId: input.coachSessionId,
    action: 'record_presentation_failure',
    causalEventId: input.requestEventId,
  });
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'record_presentation_failure',
    coachSessionId: input.coachSessionId,
    phase: input.phase,
    presentationKind: input.presentationKind,
    requestEventId: input.requestEventId,
    failureCode: input.failureCode,
  });
  return appendCoachRuntimeEvent(deps, {
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      const request = eventById(snapshot, input.requestEventId);
      const target = input.phase === 'original' ? snapshot.state.original : snapshot.state.transfer;
      const requestMatches =
        input.presentationKind === 'hint'
          ? request?.eventType === 'hint_requested' &&
            request.phase === input.phase &&
            target.pendingHintRequestEventId === request.eventId
          : input.phase === 'original' &&
            request?.eventType === 'full_solution_requested' &&
            snapshot.state.original.pendingFullSolutionRequestEventId === request.eventId;
      if (!requestMatches) throw new CoachError('COACH_ACTION_NOT_ALLOWED');
      return {
        ...baseEvent(deps, input, metadata),
        eventType: 'presentation_failed',
        phase: input.phase,
        presentationKind: input.presentationKind,
        requestEventId: input.requestEventId,
        failureCode: input.failureCode,
      };
    },
  });
}

export async function submitCoachTransferAnswer(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & { message: TrustedCoachUserMessage },
): Promise<CoachActionResult> {
  assertContinuation(input);
  const message = normalizedMessage(input.message);
  const observed = await loadCoachRuntime(deps, input.profileId, input.coachSessionId);
  const transferQuestionId = observed.state.transfer.transferQuestionId;
  if (!observed.state.transfer.assigned || !transferQuestionId) {
    throw new CoachError('TRANSFER_QUESTION_REQUIRED');
  }
  const observedAssignment = requireTransferAssignment(observed);
  if (observedAssignment.event.transferQuestionId !== transferQuestionId) {
    throw new CoachError('TRANSFER_EVALUATION_FAILED');
  }
  const operationId = modelOperationId(deps, input, message, 'submit_transfer_answer');
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'submit_transfer_answer',
    coachSessionId: input.coachSessionId,
    phase: 'transfer',
    transferQuestionId,
    trustedMessageRef: modelMessageRef(deps, message),
    studentResponseHash: hashCoachMessageText(message.text),
  });
  return appendCoachRuntimeEvent(deps, {
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      requireModelAction(snapshot, 'submit_transfer_answer');
      const assignment = requireTransferAssignment(snapshot);
      if (
        snapshot.state.transfer.transferQuestionId !== transferQuestionId ||
        assignment.event.transferQuestionId !== transferQuestionId
      ) {
        throw new CoachError('COACH_EVENT_CONFLICT');
      }
      if (messageRefAlreadyAttempted(snapshot, deps.agentSessionId, message.seq)) {
        throw new CoachError('COACH_MESSAGE_ALREADY_COUNTED');
      }
      return {
        ...baseEvent(deps, input, metadata),
        eventType: 'transfer_answer_submitted',
        phase: 'transfer',
        transferQuestionId,
        sourceUserMessageSeq: message.seq,
        studentResponse: message.text,
      };
    },
  });
}

export async function abandonCoachProblem(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & { message: TrustedCoachUserMessage },
): Promise<CoachActionResult> {
  assertContinuation(input);
  const message = normalizedMessage(input.message);
  const operationId = modelOperationId(deps, input, message, 'abandon_problem');
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'abandon_problem',
    coachSessionId: input.coachSessionId,
    trustedMessageRef: modelMessageRef(deps, message),
  });
  return appendCoachRuntimeEvent(deps, {
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      requireModelAction(snapshot, 'abandon_problem');
      return {
        ...baseEvent(deps, input, metadata),
        eventType: 'problem_abandoned',
        sourceUserMessageSeq: message.seq,
      };
    },
  });
}

function requireHintRequest(
  snapshot: CoachRuntimeSnapshot,
  requestEventId: string,
): HintRequestedEvent {
  const request = eventById(snapshot, requestEventId);
  if (!request || request.eventType !== 'hint_requested') {
    throw new CoachError('COACH_ACTION_NOT_ALLOWED');
  }
  return request;
}

export async function recordHintIssued(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & { requestEventId: string; hintText: string },
): Promise<CoachActionResult> {
  assertContinuation(input);
  assertIdentifier(input.requestEventId);
  const hintText = normalizedPresentationText(input.hintText, COACH_HINT_TEXT_MAX_LENGTH);
  const observed = await loadCoachRuntime(deps, input.profileId, input.coachSessionId);
  const request = requireHintRequest(observed, input.requestEventId);
  const operationId = deriveCoachCausalOperationId({
    coachSessionId: input.coachSessionId,
    action: 'record_hint_issued',
    causalEventId: request.eventId,
  });
  const existing = operationEvent(observed, operationId);
  const target = request.phase === 'original' ? observed.state.original : observed.state.transfer;
  const hintNumber =
    existing?.eventType === 'hint_issued'
      ? existing.hintNumber
      : ((target.hintsIssued + 1) as 1 | 2 | 3);
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'record_hint_issued',
    coachSessionId: input.coachSessionId,
    phase: request.phase,
    requestEventId: request.eventId,
    hintNumber,
    hintText,
  });
  return appendCoachRuntimeEvent(deps, {
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      const current = requireHintRequest(snapshot, request.eventId);
      const currentTarget =
        current.phase === 'original' ? snapshot.state.original : snapshot.state.transfer;
      if (currentTarget.pendingHintRequestEventId !== current.eventId) {
        throw new CoachError('COACH_ACTION_NOT_ALLOWED');
      }
      return {
        ...baseEvent(deps, input, metadata),
        eventType: 'hint_issued',
        phase: current.phase,
        requestEventId: current.eventId,
        hintNumber,
        hintText,
      };
    },
  });
}

export async function recordFullSolutionRevealed(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & {
    requestEventId: string;
    explanation: string;
    finalAnswer?: string;
  },
): Promise<CoachActionResult> {
  assertContinuation(input);
  assertIdentifier(input.requestEventId);
  const explanation = normalizedPresentationText(
    input.explanation,
    COACH_SOLUTION_EXPLANATION_MAX_LENGTH,
  );
  const finalAnswer =
    input.finalAnswer === undefined
      ? undefined
      : normalizedPresentationText(input.finalAnswer, COACH_FINAL_ANSWER_MAX_LENGTH);
  const operationId = deriveCoachCausalOperationId({
    coachSessionId: input.coachSessionId,
    action: 'record_full_solution_revealed',
    causalEventId: input.requestEventId,
  });
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'record_full_solution_revealed',
    coachSessionId: input.coachSessionId,
    phase: 'original',
    requestEventId: input.requestEventId,
    explanation,
    ...(finalAnswer ? { finalAnswer } : {}),
  });
  return appendCoachRuntimeEvent(deps, {
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      const request = eventById(snapshot, input.requestEventId);
      if (
        !request ||
        request.eventType !== 'full_solution_requested' ||
        request.phase !== 'original' ||
        snapshot.state.original.pendingFullSolutionRequestEventId !== request.eventId ||
        !snapshot.state.original.fullSolutionAvailable ||
        snapshot.state.original.viewedFullAnswer
      ) {
        throw new CoachError('FULL_SOLUTION_REQUEST_REQUIRED');
      }
      return {
        ...baseEvent(deps, input, metadata),
        eventType: 'full_solution_revealed',
        phase: 'original',
        requestEventId: request.eventId,
        explanation,
        ...(finalAnswer ? { finalAnswer } : {}),
      };
    },
  });
}

export async function recordOriginalAssessmentPrepared(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & { verifiedAssessment: VerifiedOriginalAssessment },
): Promise<CoachActionResult> {
  assertContinuation(input);
  const observed = await loadCoachRuntime(deps, input.profileId, input.coachSessionId);
  const preparedFacts = buildOriginalAssessmentPreparedFacts(
    requireCoachStart(observed),
    input.verifiedAssessment,
  );
  const operationId = deriveCoachCausalOperationId({
    coachSessionId: input.coachSessionId,
    action: 'record_original_assessment_prepared',
    causalEventId: preparedFacts.assessmentId,
    version: preparedFacts.assessmentVersion,
  });
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'record_original_assessment_prepared',
    coachSessionId: input.coachSessionId,
    ...preparedFacts,
  });
  return appendCoachRuntimeEvent(deps, {
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      const currentFacts = buildOriginalAssessmentPreparedFacts(
        requireCoachStart(snapshot),
        input.verifiedAssessment,
      );
      if (
        snapshot.state.original.assessmentEventId !== undefined ||
        snapshot.state.original.resolved ||
        createCoachOperationFingerprint(currentFacts) !==
          createCoachOperationFingerprint(preparedFacts)
      ) {
        throw new CoachError('COACH_EVENT_CONFLICT');
      }
      return {
        ...baseEvent(deps, input, metadata),
        eventType: 'original_assessment_prepared',
        ...currentFacts,
      };
    },
  });
}

function requireOriginalAssessment(snapshot: CoachRuntimeSnapshot, assessmentEventId: string) {
  const assessment = eventById(snapshot, assessmentEventId);
  if (!assessment || assessment.eventType !== 'original_assessment_prepared') {
    throw new CoachError('ORIGINAL_ATTEMPT_EVALUATION_FAILED');
  }
  return {
    event: assessment,
    verified: extractVerifiedOriginalAssessment(assessment, requireCoachStart(snapshot)),
  };
}

function requireOriginalAttempt(snapshot: CoachRuntimeSnapshot, attemptEventId: string) {
  const attempt = eventById(snapshot, attemptEventId);
  if (
    !attempt ||
    attempt.eventType !== 'student_attempt_submitted' ||
    attempt.phase !== 'original'
  ) {
    throw new CoachError('ORIGINAL_ATTEMPT_EVALUATION_FAILED');
  }
  return attempt;
}

export async function recordOriginalAttemptEvaluation(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & { assessmentEventId: string; attemptEventId: string },
): Promise<CoachActionResult> {
  assertContinuation(input);
  assertIdentifier(input.assessmentEventId);
  assertIdentifier(input.attemptEventId);
  const observed = await loadCoachRuntime(deps, input.profileId, input.coachSessionId);
  const assessment = requireOriginalAssessment(observed, input.assessmentEventId);
  const attempt = requireOriginalAttempt(observed, input.attemptEventId);
  const evaluated = evaluateTransferAnswer(
    assessment.verified.gradingSpec,
    attempt.studentResponse,
  );
  const causalIdentity = createCoachOperationFingerprint({
    assessmentEventId: assessment.event.eventId,
    attemptEventId: attempt.eventId,
  });
  const operationId = deriveCoachCausalOperationId({
    coachSessionId: input.coachSessionId,
    action: 'record_original_attempt_evaluation',
    causalEventId: causalIdentity,
  });
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'record_original_attempt_evaluation',
    coachSessionId: input.coachSessionId,
    assessmentEventId: assessment.event.eventId,
    attemptEventId: attempt.eventId,
    outcome: evaluated.outcome,
  });
  let result: CoachActionResult;
  try {
    result = await appendCoachRuntimeEvent(deps, {
      ...input,
      operationId,
      operationFingerprint,
      createEvent(metadata, snapshot) {
        const currentAssessment = requireOriginalAssessment(snapshot, input.assessmentEventId);
        const currentAttempt = requireOriginalAttempt(snapshot, input.attemptEventId);
        const currentEvaluation = evaluateTransferAnswer(
          currentAssessment.verified.gradingSpec,
          currentAttempt.studentResponse,
        );
        if (
          snapshot.state.original.assessmentEventId !== currentAssessment.event.eventId ||
          snapshot.state.original.evaluatedAttemptEventIds.includes(currentAttempt.eventId) ||
          snapshot.state.original.resolved ||
          currentEvaluation.outcome !== evaluated.outcome
        ) {
          throw new CoachError('ORIGINAL_ATTEMPT_EVALUATION_CONFLICT');
        }
        return {
          ...baseEvent(deps, input, metadata),
          eventType: 'original_attempt_evaluated',
          assessmentEventId: currentAssessment.event.eventId,
          attemptEventId: currentAttempt.eventId,
          outcome: currentEvaluation.outcome,
        };
      },
    });
  } catch (error) {
    if (error instanceof CoachError && error.code === 'COACH_EVENT_CONFLICT') {
      throw new CoachError('ORIGINAL_ATTEMPT_EVALUATION_CONFLICT');
    }
    throw error;
  }
  const persisted = eventById(result.snapshot, deriveCoachEventId(operationId));
  if (
    !persisted ||
    persisted.eventType !== 'original_attempt_evaluated' ||
    persisted.assessmentEventId !== assessment.event.eventId ||
    persisted.attemptEventId !== attempt.eventId ||
    persisted.outcome !== evaluated.outcome
  ) {
    throw new CoachError('ORIGINAL_ATTEMPT_EVALUATION_CONFLICT');
  }
  return result;
}

export async function recordOriginalResolvedFromEvaluation(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & { evaluationEventId: string },
): Promise<CoachActionResult> {
  assertContinuation(input);
  assertIdentifier(input.evaluationEventId);
  const operationId = deriveCoachCausalOperationId({
    coachSessionId: input.coachSessionId,
    action: 'record_original_resolved_from_evaluation',
    causalEventId: input.evaluationEventId,
    version: 2,
  });
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'record_original_resolved_from_evaluation',
    coachSessionId: input.coachSessionId,
    evaluationEventId: input.evaluationEventId,
    resolutionSchemaVersion: 2,
  });
  return appendCoachRuntimeEvent(deps, {
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      const evaluation = eventById(snapshot, input.evaluationEventId);
      if (
        !evaluation ||
        evaluation.eventType !== 'original_attempt_evaluated' ||
        evaluation.outcome !== 'correct' ||
        snapshot.state.original.correctEvaluationEventId !== evaluation.eventId ||
        snapshot.state.original.evaluatedAttemptEventIds.length !==
          snapshot.state.original.attemptEventIds.length ||
        snapshot.state.original.resolved ||
        snapshot.state.original.pendingHintRequestEventId !== undefined
      ) {
        throw new CoachError('COACH_ACTION_NOT_ALLOWED');
      }
      return {
        ...baseEvent(deps, input, metadata),
        eventType: 'original_resolved',
        resolutionSchemaVersion: 2,
        resolutionKind: 'evaluated_attempt',
        evaluationEventId: evaluation.eventId,
      };
    },
  });
}

export async function recordOriginalResolvedFromFullSolution(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & { fullSolutionEventId: string },
): Promise<CoachActionResult> {
  assertContinuation(input);
  assertIdentifier(input.fullSolutionEventId);
  const operationId = deriveCoachCausalOperationId({
    coachSessionId: input.coachSessionId,
    action: 'record_original_resolved_from_full_solution',
    causalEventId: input.fullSolutionEventId,
    version: 2,
  });
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'record_original_resolved_from_full_solution',
    coachSessionId: input.coachSessionId,
    fullSolutionEventId: input.fullSolutionEventId,
    resolutionSchemaVersion: 2,
  });
  return appendCoachRuntimeEvent(deps, {
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      const reveal = eventById(snapshot, input.fullSolutionEventId);
      if (
        !reveal ||
        reveal.eventType !== 'full_solution_revealed' ||
        reveal.phase !== 'original' ||
        !snapshot.state.original.viewedFullAnswer ||
        (snapshot.state.original.assessmentEventId !== undefined &&
          snapshot.state.original.evaluatedAttemptEventIds.length !==
            snapshot.state.original.attemptEventIds.length) ||
        snapshot.state.original.resolved
      ) {
        throw new CoachError('COACH_ACTION_NOT_ALLOWED');
      }
      return {
        ...baseEvent(deps, input, metadata),
        eventType: 'original_resolved',
        resolutionSchemaVersion: 2,
        resolutionKind: 'full_solution',
        fullSolutionEventId: reveal.eventId,
      };
    },
  });
}

/** Legacy writer retained for committed M2A fixtures; production M2B paths use causal v2 writers. */
export async function recordOriginalResolved(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & OriginalResolutionFacts,
): Promise<CoachActionResult> {
  assertContinuation(input);
  assertIdentifier(input.attemptEventId);
  const resolvesFromFullSolution = input.fullSolutionEventId !== undefined;
  if (resolvesFromFullSolution) assertIdentifier(input.fullSolutionEventId);
  else assertOutcome(input.outcome);
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
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      const attempt = eventById(snapshot, input.attemptEventId);
      if (
        !attempt ||
        attempt.eventType !== 'student_attempt_submitted' ||
        attempt.phase !== 'original'
      ) {
        throw new CoachError('STUDENT_ATTEMPT_REQUIRED');
      }
      const fullSolution = resolvesFromFullSolution
        ? eventById(snapshot, input.fullSolutionEventId)
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
        ...baseEvent(deps, input, metadata),
        eventType: 'original_resolved',
        attemptEventId: attempt.eventId,
        ...(resolvesFromFullSolution
          ? { fullSolutionEventId: input.fullSolutionEventId }
          : { outcome: input.outcome }),
      };
    },
  });
}

export async function assignVerifiedTransferQuestion(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & {
    originalResolvedEventId: string;
    verifiedQuestion: VerifiedTransferQuestion;
  },
): Promise<CoachActionResult> {
  assertContinuation(input);
  assertIdentifier(input.originalResolvedEventId);
  const normalizedVerifiedQuestion: VerifiedTransferQuestion = {
    ...input.verifiedQuestion,
    publicQuestion: {
      ...input.verifiedQuestion.publicQuestion,
      knowledgePointIds: normalizeKnowledgePointIds(
        input.verifiedQuestion.publicQuestion.knowledgePointIds,
      ),
    },
  };
  const assignment = buildTransferAssignment({
    coachSessionId: input.coachSessionId,
    originalResolvedEventId: input.originalResolvedEventId,
    verifiedQuestion: normalizedVerifiedQuestion,
  });
  const transferQuestionId = assignment.publicQuestion.transferQuestionId;
  const knowledgePointIds = normalizeKnowledgePointIds(assignment.publicQuestion.knowledgePointIds);
  const operationId = deriveCoachCausalOperationId({
    coachSessionId: input.coachSessionId,
    action: 'assign_verified_transfer_question',
    causalEventId: input.originalResolvedEventId,
  });
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'assign_verified_transfer_question',
    coachSessionId: input.coachSessionId,
    originalResolvedEventId: input.originalResolvedEventId,
    transferQuestionId,
    knowledgePointIds,
    validationRef: assignment.validationRef,
    assignmentSchemaVersion: TRANSFER_ASSIGNMENT_SCHEMA_VERSION,
    assignmentPayload: {
      publicQuestion: assignment.publicQuestion,
      gradingSpec: assignment.gradingSpec,
      verification: assignment.verification,
    },
  });
  return appendCoachRuntimeEvent(deps, {
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      const resolution = eventById(snapshot, input.originalResolvedEventId);
      if (
        !resolution ||
        resolution.eventType !== 'original_resolved' ||
        snapshot.state.original.resolutionEventId !== resolution.eventId ||
        snapshot.state.transfer.assigned
      ) {
        throw new CoachError('COACH_ACTION_NOT_ALLOWED');
      }
      return {
        ...baseEvent(deps, input, metadata),
        eventType: 'transfer_question_assigned',
        originalResolvedEventId: resolution.eventId,
        transferQuestionId,
        knowledgePointIds,
        validationRef: assignment.validationRef,
        assignmentSchemaVersion: TRANSFER_ASSIGNMENT_SCHEMA_VERSION,
        assignmentPayload: {
          publicQuestion: assignment.publicQuestion,
          gradingSpec: assignment.gradingSpec,
          verification: assignment.verification,
        },
      };
    },
  });
}

function requireTransferSubmission(
  snapshot: CoachRuntimeSnapshot,
  submissionEventId: string,
): TransferAnswerSubmittedEvent {
  const submission = eventById(snapshot, submissionEventId);
  if (!submission || submission.eventType !== 'transfer_answer_submitted') {
    throw new CoachError('TRANSFER_EVALUATION_FAILED');
  }
  return submission;
}

function requireTransferAssignment(snapshot: CoachRuntimeSnapshot) {
  const assignmentEventId = snapshot.state.transfer.assignmentEventId;
  const assignment = assignmentEventId ? eventById(snapshot, assignmentEventId) : undefined;
  if (!assignment || assignment.eventType !== 'transfer_question_assigned') {
    throw new CoachError('TRANSFER_QUESTION_REQUIRED');
  }
  return { event: assignment, verified: extractVerifiedTransferAssignment(assignment) };
}

export async function recordTransferEvaluation(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & { submissionEventId: string },
): Promise<CoachActionResult> {
  assertContinuation(input);
  assertIdentifier(input.submissionEventId);
  const observed = await loadCoachRuntime(deps, input.profileId, input.coachSessionId);
  const submission = requireTransferSubmission(observed, input.submissionEventId);
  const assignment = requireTransferAssignment(observed);
  if (
    assignment.event.eventId !== observed.state.transfer.assignmentEventId ||
    submission.transferQuestionId !== assignment.event.transferQuestionId
  ) {
    throw new CoachError('TRANSFER_EVALUATION_FAILED');
  }
  const evaluated = evaluateTransferAnswer(
    assignment.verified.gradingSpec,
    submission.studentResponse,
  );
  const operationId = deriveCoachCausalOperationId({
    coachSessionId: input.coachSessionId,
    action: 'record_transfer_evaluation',
    causalEventId: submission.eventId,
  });
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'record_transfer_evaluation',
    coachSessionId: input.coachSessionId,
    transferQuestionId: submission.transferQuestionId,
    submissionEventId: submission.eventId,
    outcome: evaluated.outcome,
  });
  const result = await appendCoachRuntimeEvent(deps, {
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      const current = requireTransferSubmission(snapshot, submission.eventId);
      const currentAssignment = requireTransferAssignment(snapshot);
      const currentEvaluation = evaluateTransferAnswer(
        currentAssignment.verified.gradingSpec,
        current.studentResponse,
      );
      if (
        snapshot.state.transfer.evaluationEventId !== undefined ||
        current.transferQuestionId !== snapshot.state.transfer.transferQuestionId ||
        current.transferQuestionId !== currentAssignment.event.transferQuestionId ||
        currentEvaluation.outcome !== evaluated.outcome
      ) {
        throw new CoachError('TRANSFER_EVALUATION_FAILED');
      }
      return {
        ...baseEvent(deps, input, metadata),
        eventType: 'transfer_answer_evaluated',
        transferQuestionId: current.transferQuestionId,
        submissionEventId: current.eventId,
        outcome: evaluated.outcome,
      };
    },
  });
  const persisted = eventById(result.snapshot, deriveCoachEventId(operationId));
  if (
    !persisted ||
    persisted.eventType !== 'transfer_answer_evaluated' ||
    persisted.submissionEventId !== submission.eventId ||
    persisted.transferQuestionId !== submission.transferQuestionId ||
    persisted.outcome !== evaluated.outcome
  ) {
    throw new CoachError('COACH_EVENT_CONFLICT');
  }
  return result;
}

export async function recordStudyAttemptsProjected(
  deps: CoachServiceDeps,
  input: CoachContinuationInput & { evaluationEventId: string },
): Promise<CoachActionResult> {
  assertContinuation(input);
  assertIdentifier(input.evaluationEventId);
  const projectionRef = deriveCoachProjectionRef({
    coachSessionId: input.coachSessionId,
    evaluationEventId: input.evaluationEventId,
    projectionVersion: COACH_PROJECTION_VERSION,
  });
  const operationId = deriveCoachCausalOperationId({
    coachSessionId: input.coachSessionId,
    action: 'record_study_attempts_projected',
    causalEventId: input.evaluationEventId,
    version: COACH_PROJECTION_VERSION,
  });
  const operationFingerprint = createCoachOperationFingerprint({
    action: 'record_study_attempts_projected',
    coachSessionId: input.coachSessionId,
    evaluationEventId: input.evaluationEventId,
    projectionRef,
    projectionVersion: COACH_PROJECTION_VERSION,
  });
  return appendCoachRuntimeEvent(deps, {
    ...input,
    operationId,
    operationFingerprint,
    createEvent(metadata, snapshot) {
      const evaluation = eventById(snapshot, input.evaluationEventId);
      if (
        !evaluation ||
        evaluation.eventType !== 'transfer_answer_evaluated' ||
        snapshot.state.transfer.evaluationEventId !== evaluation.eventId ||
        snapshot.state.studyAttemptsProjected
      ) {
        throw new CoachError('COACH_ACTION_NOT_ALLOWED');
      }
      return {
        ...baseEvent(deps, input, metadata),
        eventType: 'study_attempts_projected',
        evaluationEventId: evaluation.eventId,
        projectionRef,
        projectionVersion: COACH_PROJECTION_VERSION,
      };
    },
  });
}
