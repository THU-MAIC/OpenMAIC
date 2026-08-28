import {
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  validateIsoDateTime,
  type DomainValidationIssue,
  type DomainValidationResult,
} from './validation';
import { CoachError } from './coach-errors';

export const COACH_EVENT_SCHEMA_VERSION = 1 as const;
export const COACH_PROJECTION_VERSION = 1 as const;
export const COACH_TRUSTED_MESSAGE_MAX_LENGTH = 12_000;
export const COACH_OPERATION_FINGERPRINT_LENGTH = 64;

export type CoachPhase = 'original' | 'transfer';
export type CoachQuestionSource = { type: 'typed' } | { type: 'material'; materialId: string };
export type CoachOutcome = 'correct' | 'partial' | 'incorrect';

interface CoachEventBase {
  schemaVersion: typeof COACH_EVENT_SCHEMA_VERSION;
  eventId: string;
  coachSessionId: string;
  profileId: string;
  eventType: CoachEventType;
  createdAt: string;
  agentSessionId: string;
  sourceUserMessageSeq?: number;
  operationId: string;
  operationFingerprint: string;
}

export interface CoachStartedEvent extends CoachEventBase {
  eventType: 'coach_started';
  subjectId: string;
  knowledgePointIds: readonly string[];
  questionSource: CoachQuestionSource;
  questionText: string;
  sourceUserMessageSeq: number;
}

export interface StudentAttemptSubmittedEvent extends CoachEventBase {
  eventType: 'student_attempt_submitted';
  phase: 'original';
  studentResponse: string;
  sourceUserMessageSeq: number;
}

export interface HintRequestedEvent extends CoachEventBase {
  eventType: 'hint_requested';
  phase: CoachPhase;
  sourceUserMessageSeq: number;
}

export interface HintIssuedEvent extends CoachEventBase {
  eventType: 'hint_issued';
  phase: CoachPhase;
  requestEventId: string;
  hintNumber: 1 | 2 | 3;
}

export interface FullSolutionRequestedEvent extends CoachEventBase {
  eventType: 'full_solution_requested';
  phase: 'original';
  sourceUserMessageSeq: number;
}

export interface FullSolutionRevealedEvent extends CoachEventBase {
  eventType: 'full_solution_revealed';
  phase: 'original';
  requestEventId: string;
}

export interface OriginalResolvedEvent extends CoachEventBase {
  eventType: 'original_resolved';
  attemptEventId: string;
  outcome: CoachOutcome;
}

export interface TransferQuestionAssignedEvent extends CoachEventBase {
  eventType: 'transfer_question_assigned';
  originalResolvedEventId: string;
  transferQuestionId: string;
  knowledgePointIds: readonly string[];
  validationRef: string;
}

export interface TransferAnswerSubmittedEvent extends CoachEventBase {
  eventType: 'transfer_answer_submitted';
  phase: 'transfer';
  transferQuestionId: string;
  studentResponse: string;
  sourceUserMessageSeq: number;
}

export interface TransferAnswerEvaluatedEvent extends CoachEventBase {
  eventType: 'transfer_answer_evaluated';
  transferQuestionId: string;
  submissionEventId: string;
  outcome: CoachOutcome;
}

export interface StudyAttemptsProjectedEvent extends CoachEventBase {
  eventType: 'study_attempts_projected';
  evaluationEventId: string;
  projectionRef: string;
  projectionVersion: typeof COACH_PROJECTION_VERSION;
}

export interface ProblemAbandonedEvent extends CoachEventBase {
  eventType: 'problem_abandoned';
  sourceUserMessageSeq: number;
}

export type CoachEvent =
  | CoachStartedEvent
  | StudentAttemptSubmittedEvent
  | HintRequestedEvent
  | HintIssuedEvent
  | FullSolutionRequestedEvent
  | FullSolutionRevealedEvent
  | OriginalResolvedEvent
  | TransferQuestionAssignedEvent
  | TransferAnswerSubmittedEvent
  | TransferAnswerEvaluatedEvent
  | StudyAttemptsProjectedEvent
  | ProblemAbandonedEvent;

export type CoachEventType = CoachEvent['eventType'];

export const COACH_EVENT_TYPES = [
  'coach_started',
  'student_attempt_submitted',
  'hint_requested',
  'hint_issued',
  'full_solution_requested',
  'full_solution_revealed',
  'original_resolved',
  'transfer_question_assigned',
  'transfer_answer_submitted',
  'transfer_answer_evaluated',
  'study_attempts_projected',
  'problem_abandoned',
] as const satisfies readonly CoachEventType[];

const COMMON_KEYS = [
  'schemaVersion',
  'eventId',
  'coachSessionId',
  'profileId',
  'eventType',
  'createdAt',
  'agentSessionId',
  'sourceUserMessageSeq',
  'operationId',
  'operationFingerprint',
] as const;

const EVENT_KEYS: Readonly<Record<CoachEventType, ReadonlySet<string>>> = {
  coach_started: new Set([
    ...COMMON_KEYS,
    'subjectId',
    'knowledgePointIds',
    'questionSource',
    'questionText',
  ]),
  student_attempt_submitted: new Set([...COMMON_KEYS, 'phase', 'studentResponse']),
  hint_requested: new Set([...COMMON_KEYS, 'phase']),
  hint_issued: new Set([...COMMON_KEYS, 'phase', 'requestEventId', 'hintNumber']),
  full_solution_requested: new Set([...COMMON_KEYS, 'phase']),
  full_solution_revealed: new Set([...COMMON_KEYS, 'phase', 'requestEventId']),
  original_resolved: new Set([...COMMON_KEYS, 'attemptEventId', 'outcome']),
  transfer_question_assigned: new Set([
    ...COMMON_KEYS,
    'originalResolvedEventId',
    'transferQuestionId',
    'knowledgePointIds',
    'validationRef',
  ]),
  transfer_answer_submitted: new Set([
    ...COMMON_KEYS,
    'phase',
    'transferQuestionId',
    'studentResponse',
  ]),
  transfer_answer_evaluated: new Set([
    ...COMMON_KEYS,
    'transferQuestionId',
    'submissionEventId',
    'outcome',
  ]),
  study_attempts_projected: new Set([
    ...COMMON_KEYS,
    'evaluationEventId',
    'projectionRef',
    'projectionVersion',
  ]),
  problem_abandoned: new Set(COMMON_KEYS),
};

const USER_MESSAGE_EVENTS = new Set<CoachEventType>([
  'coach_started',
  'student_attempt_submitted',
  'hint_requested',
  'full_solution_requested',
  'transfer_answer_submitted',
  'problem_abandoned',
]);

function isCoachEventType(value: unknown): value is CoachEventType {
  return (COACH_EVENT_TYPES as readonly unknown[]).includes(value);
}

function validatePositiveInteger(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    pushIssue(errors, path, 'expected positive safe integer');
    return false;
  }
  return true;
}

function validateKnowledgePointIds(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    pushIssue(errors, path, 'expected 1 to 32 knowledge point ids');
    return;
  }
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (validateIdentifier(item, `${path}/${index}`, errors)) {
      if (seen.has(item)) pushIssue(errors, `${path}/${index}`, 'duplicate knowledge point id');
      seen.add(item);
    }
  });
}

function validateTrustedText(value: unknown, path: string, errors: DomainValidationIssue[]): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    pushIssue(errors, path, 'expected non-empty trusted message text');
    return;
  }
  if (value !== value.trim()) pushIssue(errors, path, 'trusted message text must be trimmed');
  if (value.length > COACH_TRUSTED_MESSAGE_MAX_LENGTH) {
    pushIssue(errors, path, `trusted message text exceeds ${COACH_TRUSTED_MESSAGE_MAX_LENGTH}`);
  }
}

function validateQuestionSource(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): void {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected question source object');
    return;
  }
  if (value.type === 'typed') {
    rejectUnknownKeys(value, new Set(['type']), path, errors);
    return;
  }
  if (value.type === 'material') {
    rejectUnknownKeys(value, new Set(['type', 'materialId']), path, errors);
    validateIdentifier(value.materialId, `${path}/materialId`, errors);
    return;
  }
  pushIssue(errors, `${path}/type`, 'unknown question source type');
}

function validateOutcome(value: unknown, path: string, errors: DomainValidationIssue[]): void {
  if (value !== 'correct' && value !== 'partial' && value !== 'incorrect') {
    pushIssue(errors, path, 'unknown coach outcome');
  }
}

function validatePhase(value: unknown, path: string, errors: DomainValidationIssue[]): void {
  if (value !== 'original' && value !== 'transfer') {
    pushIssue(errors, path, 'unknown coach phase');
  }
}

function validateFingerprint(value: unknown, errors: DomainValidationIssue[]): void {
  if (
    typeof value !== 'string' ||
    value.length !== COACH_OPERATION_FINGERPRINT_LENGTH ||
    !/^[a-f0-9]+$/u.test(value)
  ) {
    pushIssue(errors, '/operationFingerprint', 'expected a 64-character lowercase hex digest');
  }
}

export function validateCoachEvent(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    return { valid: false, errors: [{ path: '/', message: 'expected coach event object' }] };
  }

  const eventType = value.eventType;
  if (!isCoachEventType(eventType)) {
    pushIssue(errors, '/eventType', 'unknown coach event type');
    rejectUnknownKeys(value, new Set(COMMON_KEYS), '', errors);
  } else {
    rejectUnknownKeys(value, EVENT_KEYS[eventType], '', errors);
  }

  if (value.schemaVersion !== COACH_EVENT_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', 'unsupported coach event schema version');
  }
  validateIdentifier(value.eventId, '/eventId', errors);
  validateIdentifier(value.coachSessionId, '/coachSessionId', errors);
  validateIdentifier(value.profileId, '/profileId', errors);
  validateIsoDateTime(value.createdAt, '/createdAt', errors);
  validateIdentifier(value.agentSessionId, '/agentSessionId', errors);
  validateIdentifier(value.operationId, '/operationId', errors);
  validateFingerprint(value.operationFingerprint, errors);

  if (Object.hasOwn(value, 'sourceUserMessageSeq')) {
    validatePositiveInteger(value.sourceUserMessageSeq, '/sourceUserMessageSeq', errors);
  } else if (isCoachEventType(eventType) && USER_MESSAGE_EVENTS.has(eventType)) {
    pushIssue(errors, '/sourceUserMessageSeq', 'source user message seq is required');
  }

  if (eventType === 'coach_started') {
    validateIdentifier(value.subjectId, '/subjectId', errors);
    validateKnowledgePointIds(value.knowledgePointIds, '/knowledgePointIds', errors);
    validateQuestionSource(value.questionSource, '/questionSource', errors);
    validateTrustedText(value.questionText, '/questionText', errors);
  } else if (eventType === 'student_attempt_submitted') {
    if (value.phase !== 'original') pushIssue(errors, '/phase', 'original attempt phase required');
    validateTrustedText(value.studentResponse, '/studentResponse', errors);
  } else if (eventType === 'hint_requested') {
    validatePhase(value.phase, '/phase', errors);
  } else if (eventType === 'hint_issued') {
    validatePhase(value.phase, '/phase', errors);
    validateIdentifier(value.requestEventId, '/requestEventId', errors);
    if (value.hintNumber !== 1 && value.hintNumber !== 2 && value.hintNumber !== 3) {
      pushIssue(errors, '/hintNumber', 'hint number must be 1, 2, or 3');
    }
  } else if (eventType === 'full_solution_requested') {
    if (value.phase !== 'original') pushIssue(errors, '/phase', 'original solution phase required');
  } else if (eventType === 'full_solution_revealed') {
    if (value.phase !== 'original') pushIssue(errors, '/phase', 'original solution phase required');
    validateIdentifier(value.requestEventId, '/requestEventId', errors);
  } else if (eventType === 'original_resolved') {
    validateIdentifier(value.attemptEventId, '/attemptEventId', errors);
    validateOutcome(value.outcome, '/outcome', errors);
  } else if (eventType === 'transfer_question_assigned') {
    validateIdentifier(value.originalResolvedEventId, '/originalResolvedEventId', errors);
    validateIdentifier(value.transferQuestionId, '/transferQuestionId', errors);
    validateKnowledgePointIds(value.knowledgePointIds, '/knowledgePointIds', errors);
    validateIdentifier(value.validationRef, '/validationRef', errors);
  } else if (eventType === 'transfer_answer_submitted') {
    if (value.phase !== 'transfer') pushIssue(errors, '/phase', 'transfer attempt phase required');
    validateIdentifier(value.transferQuestionId, '/transferQuestionId', errors);
    validateTrustedText(value.studentResponse, '/studentResponse', errors);
  } else if (eventType === 'transfer_answer_evaluated') {
    validateIdentifier(value.transferQuestionId, '/transferQuestionId', errors);
    validateIdentifier(value.submissionEventId, '/submissionEventId', errors);
    validateOutcome(value.outcome, '/outcome', errors);
  } else if (eventType === 'study_attempts_projected') {
    validateIdentifier(value.evaluationEventId, '/evaluationEventId', errors);
    validateIdentifier(value.projectionRef, '/projectionRef', errors);
    if (value.projectionVersion !== COACH_PROJECTION_VERSION) {
      pushIssue(errors, '/projectionVersion', 'unsupported projection version');
    }
  }

  return finishValidation(errors);
}

export function assertCoachEvent(value: unknown): asserts value is CoachEvent {
  if (!validateCoachEvent(value).valid) throw new CoachError('COACH_EVENT_CONFLICT');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function coachEventFactsEqual(left: CoachEvent, right: CoachEvent): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}
