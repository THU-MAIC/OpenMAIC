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
export const COACH_HINT_TEXT_MAX_LENGTH = 1_200;
export const COACH_SOLUTION_EXPLANATION_MAX_LENGTH = 12_000;
export const COACH_FINAL_ANSWER_MAX_LENGTH = 2_000;
export const COACH_TRANSFER_QUESTION_MAX_LENGTH = 4_000;
export const COACH_TRANSFER_OPTION_TEXT_MAX_LENGTH = 1_000;
export const COACH_TRANSFER_ASSIGNMENT_SCHEMA_VERSION = 1 as const;
export const COACH_ORIGINAL_ASSESSMENT_VERSION = 1 as const;
export const COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION_V2 = 2 as const;
export const COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION = 3 as const;

export type CoachPhase = 'original' | 'transfer';
export type CoachQuestionSource = { type: 'typed' } | { type: 'material'; materialId: string };
export type CoachOutcome = 'correct' | 'partial' | 'incorrect';
export type CoachTransferOutcome = Exclude<CoachOutcome, 'partial'>;
export type CoachPresentationKind = 'hint' | 'full_solution';
export const COACH_PRESENTATION_FAILURE_CODES = [
  'COACH_PROFILE_NOT_FOUND',
  'HINT_GENERATION_FAILED',
  'HINT_CONTENT_INVALID',
  'HINT_CONTENT_LEAKED',
  'FULL_SOLUTION_GENERATION_FAILED',
  'FULL_SOLUTION_CONTENT_INVALID',
  'COACH_GENERATION_UNAVAILABLE',
  'MATERIAL_SOURCE_NOT_SUPPORTED',
  'MATERIAL_SOURCE_NOT_VERIFIED',
  'COACH_SESSION_CONFLICT',
  'COACH_RUNTIME_UNAVAILABLE',
] as const;
export type CoachPresentationFailureCode = (typeof COACH_PRESENTATION_FAILURE_CODES)[number];

const PRESENTATION_FAILURE_CODES_BY_KIND: Readonly<
  Record<CoachPresentationKind, ReadonlySet<CoachPresentationFailureCode>>
> = {
  hint: new Set([
    'HINT_GENERATION_FAILED',
    'HINT_CONTENT_INVALID',
    'HINT_CONTENT_LEAKED',
    'COACH_SESSION_CONFLICT',
    'COACH_RUNTIME_UNAVAILABLE',
  ]),
  full_solution: new Set([
    'COACH_PROFILE_NOT_FOUND',
    'FULL_SOLUTION_GENERATION_FAILED',
    'FULL_SOLUTION_CONTENT_INVALID',
    'COACH_GENERATION_UNAVAILABLE',
    'MATERIAL_SOURCE_NOT_SUPPORTED',
    'MATERIAL_SOURCE_NOT_VERIFIED',
    'COACH_SESSION_CONFLICT',
    'COACH_RUNTIME_UNAVAILABLE',
  ]),
};

/** Keep durable presentation failures bound to the presentation they attempted. */
export function isCoachPresentationFailureCodeForKind(
  presentationKind: unknown,
  failureCode: unknown,
): failureCode is CoachPresentationFailureCode {
  if (
    (presentationKind !== 'hint' && presentationKind !== 'full_solution') ||
    typeof failureCode !== 'string'
  ) {
    return false;
  }
  return PRESENTATION_FAILURE_CODES_BY_KIND[presentationKind].has(
    failureCode as CoachPresentationFailureCode,
  );
}

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

export type CoachObjectiveQuestionType =
  | 'single_choice'
  | 'multiple_choice'
  | 'numeric'
  | 'exact_short_answer';

export const COACH_ORIGINAL_ASSESSMENT_UNAVAILABLE_REASONS = ['unsupported_question_type'] as const;
export type CoachOriginalAssessmentUnavailableReason =
  (typeof COACH_ORIGINAL_ASSESSMENT_UNAVAILABLE_REASONS)[number];

export interface OriginalAssessmentPreparedEvent extends CoachEventBase {
  eventType: 'original_assessment_prepared';
  assessmentVersion: typeof COACH_ORIGINAL_ASSESSMENT_VERSION;
  assessmentId: string;
  questionFingerprint: string;
  questionType: CoachObjectiveQuestionType;
  verificationRef: string;
  /** Closed and validated again by the server-only assessment extractor. */
  assessmentPayload: unknown;
}

export interface OriginalAssessmentUnavailableEvent extends CoachEventBase {
  eventType: 'original_assessment_unavailable';
  assessmentVersion: typeof COACH_ORIGINAL_ASSESSMENT_VERSION;
  questionFingerprint: string;
  reason: CoachOriginalAssessmentUnavailableReason;
}

export interface OriginalAttemptEvaluatedEvent extends CoachEventBase {
  eventType: 'original_attempt_evaluated';
  assessmentEventId: string;
  attemptEventId: string;
  outcome: CoachTransferOutcome;
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
  hintText: string;
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
  explanation: string;
  finalAnswer?: string;
}

export interface CoachPresentationFailedEvent extends CoachEventBase {
  eventType: 'presentation_failed';
  phase: CoachPhase;
  presentationKind: CoachPresentationKind;
  requestEventId: string;
  failureCode: CoachPresentationFailureCode;
}

interface OriginalResolvedEventBase extends CoachEventBase {
  eventType: 'original_resolved';
}

/** Legacy/server-graded resolution with an explicit original outcome. */
export interface OriginalOutcomeResolvedEvent extends OriginalResolvedEventBase {
  attemptEventId: string;
  outcome: CoachOutcome;
  fullSolutionEventId?: never;
  resolutionSchemaVersion?: never;
  resolutionKind?: never;
  evaluationEventId?: never;
}

/** Full-answer resolution records the reveal fact without inventing an outcome. */
export interface OriginalFullSolutionResolvedEvent extends OriginalResolvedEventBase {
  attemptEventId: string;
  fullSolutionEventId: string;
  outcome?: never;
  resolutionSchemaVersion?: never;
  resolutionKind?: never;
  evaluationEventId?: never;
}

export interface OriginalEvaluatedAttemptResolvedEvent extends OriginalResolvedEventBase {
  resolutionSchemaVersion:
    | typeof COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION_V2
    | typeof COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION;
  resolutionKind: 'evaluated_attempt';
  evaluationEventId: string;
  attemptEventId?: never;
  outcome?: never;
  fullSolutionEventId?: never;
}

export interface OriginalFullSolutionResolvedEventV2 extends OriginalResolvedEventBase {
  resolutionSchemaVersion:
    | typeof COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION_V2
    | typeof COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION;
  resolutionKind: 'full_solution';
  fullSolutionEventId: string;
  attemptEventId?: never;
  outcome?: never;
  evaluationEventId?: never;
}

export type OriginalResolvedEvent =
  | OriginalOutcomeResolvedEvent
  | OriginalFullSolutionResolvedEvent
  | OriginalEvaluatedAttemptResolvedEvent
  | OriginalFullSolutionResolvedEventV2;

export interface TransferQuestionAssignedEvent extends CoachEventBase {
  eventType: 'transfer_question_assigned';
  originalResolvedEventId: string;
  transferQuestionId: string;
  knowledgePointIds: readonly string[];
  validationRef: string;
  assignmentSchemaVersion?: typeof COACH_TRANSFER_ASSIGNMENT_SCHEMA_VERSION;
  /** Validated manually and intentionally opaque outside the server-only assignment path. */
  assignmentPayload?: unknown;
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
  outcome: CoachTransferOutcome;
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
  | OriginalAssessmentPreparedEvent
  | OriginalAssessmentUnavailableEvent
  | OriginalAttemptEvaluatedEvent
  | HintRequestedEvent
  | HintIssuedEvent
  | FullSolutionRequestedEvent
  | FullSolutionRevealedEvent
  | CoachPresentationFailedEvent
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
  'original_assessment_prepared',
  'original_assessment_unavailable',
  'original_attempt_evaluated',
  'hint_requested',
  'hint_issued',
  'full_solution_requested',
  'full_solution_revealed',
  'presentation_failed',
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
  original_assessment_prepared: new Set([
    ...COMMON_KEYS,
    'assessmentVersion',
    'assessmentId',
    'questionFingerprint',
    'questionType',
    'verificationRef',
    'assessmentPayload',
  ]),
  original_assessment_unavailable: new Set([
    ...COMMON_KEYS,
    'assessmentVersion',
    'questionFingerprint',
    'reason',
  ]),
  original_attempt_evaluated: new Set([
    ...COMMON_KEYS,
    'assessmentEventId',
    'attemptEventId',
    'outcome',
  ]),
  hint_requested: new Set([...COMMON_KEYS, 'phase']),
  hint_issued: new Set([...COMMON_KEYS, 'phase', 'requestEventId', 'hintNumber', 'hintText']),
  full_solution_requested: new Set([...COMMON_KEYS, 'phase']),
  full_solution_revealed: new Set([
    ...COMMON_KEYS,
    'phase',
    'requestEventId',
    'explanation',
    'finalAnswer',
  ]),
  presentation_failed: new Set([
    ...COMMON_KEYS,
    'phase',
    'presentationKind',
    'requestEventId',
    'failureCode',
  ]),
  original_resolved: new Set([
    ...COMMON_KEYS,
    'attemptEventId',
    'outcome',
    'fullSolutionEventId',
    'resolutionSchemaVersion',
    'resolutionKind',
    'evaluationEventId',
  ]),
  transfer_question_assigned: new Set([
    ...COMMON_KEYS,
    'originalResolvedEventId',
    'transferQuestionId',
    'knowledgePointIds',
    'validationRef',
    'assignmentSchemaVersion',
    'assignmentPayload',
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

function validatePresentationText(
  value: unknown,
  path: string,
  maxLength: number,
  errors: DomainValidationIssue[],
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    pushIssue(errors, path, 'expected non-empty presentation text');
    return;
  }
  if (value !== value.trim()) pushIssue(errors, path, 'presentation text must be trimmed');
  if (value.length > maxLength) {
    pushIssue(errors, path, `presentation text exceeds ${maxLength}`);
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

function validatePresentationFailureCode(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): void {
  if (!(COACH_PRESENTATION_FAILURE_CODES as readonly unknown[]).includes(value)) {
    pushIssue(errors, path, 'unknown presentation failure code');
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

const TRANSFER_QUESTION_TYPES = [
  'single_choice',
  'multiple_choice',
  'numeric',
  'exact_short_answer',
] as const;

const TRANSFER_DIFFICULTIES = ['slightly_easier', 'same', 'slightly_harder'] as const;

const TRANSFER_VERIFICATION_CHECKS = [
  'sameKnowledgePoint',
  'selfContained',
  'answerConsistent',
  'answerNotLeaked',
  'singleAnswerOrExactSet',
  'middleSchoolScope',
  'meaningfullyDifferent',
] as const;

const ORIGINAL_ASSESSMENT_TYPES = [
  'single_choice',
  'multiple_choice',
  'numeric',
  'exact_short_answer',
] as const;

const ORIGINAL_ASSESSMENT_VERIFICATION_CHECKS = [
  'objectiveType',
  'questionConsistent',
  'answerConsistent',
  'singleAnswerOrExactSet',
  'middleSchoolScope',
] as const;

function validateTrimmedText(
  value: unknown,
  path: string,
  maxLength: number,
  errors: DomainValidationIssue[],
): void {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    pushIssue(errors, path, 'expected non-empty trimmed text');
    return;
  }
  if (value.length > maxLength) pushIssue(errors, path, `text exceeds ${maxLength}`);
}

function validateTransferOptions(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const seenText = new Set<string>();
  if (!Array.isArray(value) || value.length < 3 || value.length > 6) {
    pushIssue(errors, path, 'expected 3 to 6 options');
    return ids;
  }
  value.forEach((option, index) => {
    const optionPath = `${path}/${index}`;
    if (!isPlainRecord(option)) {
      pushIssue(errors, optionPath, 'expected option object');
      return;
    }
    rejectUnknownKeys(option, new Set(['id', 'text']), optionPath, errors);
    if (validateIdentifier(option.id, `${optionPath}/id`, errors)) {
      if (seen.has(option.id)) pushIssue(errors, `${optionPath}/id`, 'duplicate option id');
      seen.add(option.id);
      ids.push(option.id);
    }
    validateTrimmedText(
      option.text,
      `${optionPath}/text`,
      COACH_TRANSFER_OPTION_TEXT_MAX_LENGTH,
      errors,
    );
    if (typeof option.text === 'string') {
      const normalizedText = option.text.normalize('NFKC').trim().replace(/\s+/gu, ' ');
      if (seenText.has(normalizedText)) {
        pushIssue(errors, `${optionPath}/text`, 'duplicate normalized option text');
      }
      seenText.add(normalizedText);
    }
  });
  return ids;
}

function validateTransferPublicQuestion(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): readonly string[] {
  let optionIds: readonly string[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected public transfer question object');
    return optionIds;
  }
  rejectUnknownKeys(
    value,
    new Set([
      'schemaVersion',
      'transferQuestionId',
      'type',
      'question',
      'options',
      'knowledgePointIds',
      'difficulty',
    ]),
    path,
    errors,
  );
  if (value.schemaVersion !== 1) {
    pushIssue(errors, `${path}/schemaVersion`, 'unsupported public question schema version');
  }
  validateIdentifier(value.transferQuestionId, `${path}/transferQuestionId`, errors);
  if (!(TRANSFER_QUESTION_TYPES as readonly unknown[]).includes(value.type)) {
    pushIssue(errors, `${path}/type`, 'unsupported transfer question type');
  }
  validateTrimmedText(
    value.question,
    `${path}/question`,
    COACH_TRANSFER_QUESTION_MAX_LENGTH,
    errors,
  );
  validateKnowledgePointIds(value.knowledgePointIds, `${path}/knowledgePointIds`, errors);
  if (!(TRANSFER_DIFFICULTIES as readonly unknown[]).includes(value.difficulty)) {
    pushIssue(errors, `${path}/difficulty`, 'unknown transfer question difficulty');
  }

  const choice = value.type === 'single_choice' || value.type === 'multiple_choice';
  if (choice) {
    optionIds = validateTransferOptions(value.options, `${path}/options`, errors);
  } else if (Object.hasOwn(value, 'options')) {
    pushIssue(errors, `${path}/options`, 'options are allowed only for choice questions');
  }
  return optionIds;
}

function validateAcceptedAnswers(
  value: unknown,
  path: string,
  caseMode: unknown,
  errors: DomainValidationIssue[],
): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    pushIssue(errors, path, 'expected 1 to 16 accepted answers');
    return;
  }
  const seen = new Set<string>();
  value.forEach((answer, index) => {
    const answerPath = `${path}/${index}`;
    validateTrimmedText(answer, answerPath, 256, errors);
    if (typeof answer !== 'string') return;
    const normalized = answer.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (answer !== normalized) pushIssue(errors, answerPath, 'accepted answer must be normalized');
    const comparable =
      caseMode === 'ascii_case_insensitive'
        ? normalized.replace(/[A-Z]/gu, (character) => character.toLowerCase())
        : normalized;
    if (seen.has(comparable)) pushIssue(errors, answerPath, 'duplicate accepted answer');
    seen.add(comparable);
  });
}

function validateTransferGradingSpec(
  value: unknown,
  path: string,
  publicType: unknown,
  publicOptionIds: readonly string[],
  errors: DomainValidationIssue[],
): void {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected private grading spec object');
    return;
  }
  if (value.schemaVersion !== 1) {
    pushIssue(errors, `${path}/schemaVersion`, 'unsupported grading spec schema version');
  }
  if (value.type !== publicType) {
    pushIssue(errors, `${path}/type`, 'grading spec type must match public question type');
  }
  const optionIds = new Set(publicOptionIds);

  const validateGradingOptionIds = (): void => {
    if (!Array.isArray(value.optionIds)) {
      pushIssue(errors, `${path}/optionIds`, 'expected ordered public option ids');
      return;
    }
    value.optionIds.forEach((id, index) => {
      validateIdentifier(id, `${path}/optionIds/${index}`, errors);
    });
    if (
      value.optionIds.length !== publicOptionIds.length ||
      value.optionIds.some((id, index) => id !== publicOptionIds[index])
    ) {
      pushIssue(errors, `${path}/optionIds`, 'grading option ids must match public option order');
    }
  };

  if (value.type === 'single_choice') {
    rejectUnknownKeys(
      value,
      new Set(['schemaVersion', 'type', 'optionIds', 'correctOptionId']),
      path,
      errors,
    );
    validateGradingOptionIds();
    if (validateIdentifier(value.correctOptionId, `${path}/correctOptionId`, errors)) {
      if (!optionIds.has(value.correctOptionId)) {
        pushIssue(errors, `${path}/correctOptionId`, 'correct option is not in public options');
      }
    }
    return;
  }
  if (value.type === 'multiple_choice') {
    rejectUnknownKeys(
      value,
      new Set(['schemaVersion', 'type', 'optionIds', 'correctOptionIds']),
      path,
      errors,
    );
    validateGradingOptionIds();
    if (!Array.isArray(value.correctOptionIds) || value.correctOptionIds.length === 0) {
      pushIssue(errors, `${path}/correctOptionIds`, 'expected at least one correct option id');
      return;
    }
    const seen = new Set<string>();
    value.correctOptionIds.forEach((id, index) => {
      const idPath = `${path}/correctOptionIds/${index}`;
      if (validateIdentifier(id, idPath, errors)) {
        if (seen.has(id)) pushIssue(errors, idPath, 'duplicate correct option id');
        if (!optionIds.has(id))
          pushIssue(errors, idPath, 'correct option is not in public options');
        seen.add(id);
      }
    });
    if (optionIds.size > 0 && seen.size >= optionIds.size) {
      pushIssue(
        errors,
        `${path}/correctOptionIds`,
        'multiple choice must include an incorrect option',
      );
    }
    return;
  }
  if (value.type === 'numeric') {
    rejectUnknownKeys(
      value,
      new Set(['schemaVersion', 'type', 'expectedNumericValue', 'tolerance']),
      path,
      errors,
    );
    if (
      typeof value.expectedNumericValue !== 'number' ||
      !Number.isFinite(value.expectedNumericValue)
    ) {
      pushIssue(errors, `${path}/expectedNumericValue`, 'expected a finite numeric answer');
    }
    if (value.tolerance !== 0 || !Number.isFinite(value.tolerance)) {
      pushIssue(errors, `${path}/tolerance`, 'first-version numeric tolerance must be zero');
    }
    return;
  }
  if (value.type === 'exact_short_answer') {
    rejectUnknownKeys(
      value,
      new Set(['schemaVersion', 'type', 'acceptedAnswers', 'caseMode']),
      path,
      errors,
    );
    validateAcceptedAnswers(
      value.acceptedAnswers,
      `${path}/acceptedAnswers`,
      value.caseMode,
      errors,
    );
    if (value.caseMode !== 'case_sensitive' && value.caseMode !== 'ascii_case_insensitive') {
      pushIssue(errors, `${path}/caseMode`, 'unsupported short-answer case mode');
    }
    return;
  }
  pushIssue(errors, `${path}/type`, 'unsupported grading spec type');
  rejectUnknownKeys(value, new Set(['schemaVersion', 'type']), path, errors);
}

function validateTransferVerification(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): void {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected verification object');
    return;
  }
  rejectUnknownKeys(
    value,
    new Set(['schemaVersion', 'status', 'candidateFingerprint', 'verifierVersion', 'checks']),
    path,
    errors,
  );
  if (value.schemaVersion !== 1) {
    pushIssue(errors, `${path}/schemaVersion`, 'unsupported verification schema version');
  }
  if (value.status !== 'verified') pushIssue(errors, `${path}/status`, 'verified status required');
  if (
    typeof value.candidateFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.candidateFingerprint)
  ) {
    pushIssue(errors, `${path}/candidateFingerprint`, 'expected lowercase SHA-256 fingerprint');
  }
  if (value.verifierVersion !== 1) {
    pushIssue(errors, `${path}/verifierVersion`, 'unsupported verifier version');
  }
  if (!isPlainRecord(value.checks)) {
    pushIssue(errors, `${path}/checks`, 'expected verification checks object');
    return;
  }
  rejectUnknownKeys(value.checks, new Set(TRANSFER_VERIFICATION_CHECKS), `${path}/checks`, errors);
  for (const check of TRANSFER_VERIFICATION_CHECKS) {
    if (value.checks[check] !== true) {
      pushIssue(errors, `${path}/checks/${check}`, 'verified assignment requires a true check');
    }
  }
}

function validateTransferAssignmentExtension(
  value: Record<string, unknown>,
  errors: DomainValidationIssue[],
): void {
  const hasVersion = Object.hasOwn(value, 'assignmentSchemaVersion');
  const hasPayload = Object.hasOwn(value, 'assignmentPayload');
  if (hasVersion !== hasPayload) {
    pushIssue(
      errors,
      '/assignmentPayload',
      'assignment schema version and payload must be present together',
    );
    return;
  }
  if (!hasVersion) return;
  if (value.assignmentSchemaVersion !== COACH_TRANSFER_ASSIGNMENT_SCHEMA_VERSION) {
    pushIssue(errors, '/assignmentSchemaVersion', 'unsupported transfer assignment version');
  }
  if (!isPlainRecord(value.assignmentPayload)) {
    pushIssue(errors, '/assignmentPayload', 'expected assignment payload object');
    return;
  }
  const payload = value.assignmentPayload;
  rejectUnknownKeys(
    payload,
    new Set(['publicQuestion', 'gradingSpec', 'verification']),
    '/assignmentPayload',
    errors,
  );
  const optionIds = validateTransferPublicQuestion(
    payload.publicQuestion,
    '/assignmentPayload/publicQuestion',
    errors,
  );
  const publicType = isPlainRecord(payload.publicQuestion)
    ? payload.publicQuestion.type
    : undefined;
  validateTransferGradingSpec(
    payload.gradingSpec,
    '/assignmentPayload/gradingSpec',
    publicType,
    optionIds,
    errors,
  );
  validateTransferVerification(payload.verification, '/assignmentPayload/verification', errors);
}

function validateOriginalAssessmentVerification(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): void {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected original assessment verification object');
    return;
  }
  rejectUnknownKeys(
    value,
    new Set(['schemaVersion', 'status', 'candidateFingerprint', 'verifierVersion', 'checks']),
    path,
    errors,
  );
  if (value.schemaVersion !== 1) {
    pushIssue(errors, `${path}/schemaVersion`, 'unsupported verification schema version');
  }
  if (value.status !== 'verified') pushIssue(errors, `${path}/status`, 'verified status required');
  if (
    typeof value.candidateFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.candidateFingerprint)
  ) {
    pushIssue(errors, `${path}/candidateFingerprint`, 'expected lowercase SHA-256 fingerprint');
  }
  if (value.verifierVersion !== 1) {
    pushIssue(errors, `${path}/verifierVersion`, 'unsupported verifier version');
  }
  if (!isPlainRecord(value.checks)) {
    pushIssue(errors, `${path}/checks`, 'expected verification checks object');
    return;
  }
  rejectUnknownKeys(
    value.checks,
    new Set(ORIGINAL_ASSESSMENT_VERIFICATION_CHECKS),
    `${path}/checks`,
    errors,
  );
  for (const check of ORIGINAL_ASSESSMENT_VERIFICATION_CHECKS) {
    if (value.checks[check] !== true) {
      pushIssue(errors, `${path}/checks/${check}`, 'verified assessment requires a true check');
    }
  }
}

function validateOriginalAssessmentExtension(
  value: Record<string, unknown>,
  errors: DomainValidationIssue[],
): void {
  if (value.assessmentVersion !== COACH_ORIGINAL_ASSESSMENT_VERSION) {
    pushIssue(errors, '/assessmentVersion', 'unsupported original assessment version');
  }
  validateIdentifier(value.assessmentId, '/assessmentId', errors);
  validateOriginalQuestionFingerprint(value.questionFingerprint, errors);
  if (!(ORIGINAL_ASSESSMENT_TYPES as readonly unknown[]).includes(value.questionType)) {
    pushIssue(errors, '/questionType', 'unsupported original assessment type');
  }
  validateIdentifier(value.verificationRef, '/verificationRef', errors);
  if (!isPlainRecord(value.assessmentPayload)) {
    pushIssue(errors, '/assessmentPayload', 'expected original assessment payload object');
    return;
  }
  const payload = value.assessmentPayload;
  rejectUnknownKeys(
    payload,
    new Set(['gradingSpec', 'verification']),
    '/assessmentPayload',
    errors,
  );
  const optionIds =
    isPlainRecord(payload.gradingSpec) && Array.isArray(payload.gradingSpec.optionIds)
      ? payload.gradingSpec.optionIds.filter((item): item is string => typeof item === 'string')
      : [];
  validateTransferGradingSpec(
    payload.gradingSpec,
    '/assessmentPayload/gradingSpec',
    value.questionType,
    optionIds,
    errors,
  );
  validateOriginalAssessmentVerification(
    payload.verification,
    '/assessmentPayload/verification',
    errors,
  );
}

function validateOriginalQuestionFingerprint(
  value: unknown,
  errors: DomainValidationIssue[],
): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    pushIssue(errors, '/questionFingerprint', 'expected lowercase SHA-256 fingerprint');
  }
}

function validateOriginalAssessmentUnavailable(
  value: Record<string, unknown>,
  errors: DomainValidationIssue[],
): void {
  if (value.assessmentVersion !== COACH_ORIGINAL_ASSESSMENT_VERSION) {
    pushIssue(errors, '/assessmentVersion', 'unsupported original assessment version');
  }
  validateOriginalQuestionFingerprint(value.questionFingerprint, errors);
  if (
    !(COACH_ORIGINAL_ASSESSMENT_UNAVAILABLE_REASONS as readonly unknown[]).includes(value.reason)
  ) {
    pushIssue(errors, '/reason', 'unknown original assessment unavailable reason');
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
  } else if (eventType === 'original_assessment_prepared') {
    validateOriginalAssessmentExtension(value, errors);
  } else if (eventType === 'original_assessment_unavailable') {
    validateOriginalAssessmentUnavailable(value, errors);
  } else if (eventType === 'original_attempt_evaluated') {
    validateIdentifier(value.assessmentEventId, '/assessmentEventId', errors);
    validateIdentifier(value.attemptEventId, '/attemptEventId', errors);
    if (value.outcome !== 'correct' && value.outcome !== 'incorrect') {
      pushIssue(errors, '/outcome', 'original evaluation outcome must be correct or incorrect');
    }
  } else if (eventType === 'hint_requested') {
    validatePhase(value.phase, '/phase', errors);
  } else if (eventType === 'hint_issued') {
    validatePhase(value.phase, '/phase', errors);
    validateIdentifier(value.requestEventId, '/requestEventId', errors);
    if (value.hintNumber !== 1 && value.hintNumber !== 2 && value.hintNumber !== 3) {
      pushIssue(errors, '/hintNumber', 'hint number must be 1, 2, or 3');
    }
    validatePresentationText(value.hintText, '/hintText', COACH_HINT_TEXT_MAX_LENGTH, errors);
  } else if (eventType === 'full_solution_requested') {
    if (value.phase !== 'original') pushIssue(errors, '/phase', 'original solution phase required');
  } else if (eventType === 'full_solution_revealed') {
    if (value.phase !== 'original') pushIssue(errors, '/phase', 'original solution phase required');
    validateIdentifier(value.requestEventId, '/requestEventId', errors);
    validatePresentationText(
      value.explanation,
      '/explanation',
      COACH_SOLUTION_EXPLANATION_MAX_LENGTH,
      errors,
    );
    if (Object.hasOwn(value, 'finalAnswer')) {
      validatePresentationText(
        value.finalAnswer,
        '/finalAnswer',
        COACH_FINAL_ANSWER_MAX_LENGTH,
        errors,
      );
    }
  } else if (eventType === 'presentation_failed') {
    validatePhase(value.phase, '/phase', errors);
    if (value.presentationKind !== 'hint' && value.presentationKind !== 'full_solution') {
      pushIssue(errors, '/presentationKind', 'unknown presentation kind');
    }
    if (value.presentationKind === 'full_solution' && value.phase !== 'original') {
      pushIssue(errors, '/phase', 'full solution failure requires original phase');
    }
    validateIdentifier(value.requestEventId, '/requestEventId', errors);
    validatePresentationFailureCode(value.failureCode, '/failureCode', errors);
    if (
      (value.presentationKind === 'hint' || value.presentationKind === 'full_solution') &&
      (COACH_PRESENTATION_FAILURE_CODES as readonly unknown[]).includes(value.failureCode) &&
      !isCoachPresentationFailureCodeForKind(value.presentationKind, value.failureCode)
    ) {
      pushIssue(errors, '/failureCode', 'failure code does not match presentation kind');
    }
  } else if (eventType === 'original_resolved') {
    const versioned =
      Object.hasOwn(value, 'resolutionSchemaVersion') ||
      Object.hasOwn(value, 'resolutionKind') ||
      Object.hasOwn(value, 'evaluationEventId');
    if (versioned) {
      if (
        value.resolutionSchemaVersion !== COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION_V2 &&
        value.resolutionSchemaVersion !== COACH_ORIGINAL_RESOLUTION_SCHEMA_VERSION
      ) {
        pushIssue(errors, '/resolutionSchemaVersion', 'unsupported original resolution version');
      }
      if (value.resolutionKind === 'evaluated_attempt') {
        validateIdentifier(value.evaluationEventId, '/evaluationEventId', errors);
        if (
          Object.hasOwn(value, 'attemptEventId') ||
          Object.hasOwn(value, 'outcome') ||
          Object.hasOwn(value, 'fullSolutionEventId')
        ) {
          pushIssue(
            errors,
            '/resolutionKind',
            'evaluated resolution accepts only evaluationEventId',
          );
        }
      } else if (value.resolutionKind === 'full_solution') {
        validateIdentifier(value.fullSolutionEventId, '/fullSolutionEventId', errors);
        if (
          Object.hasOwn(value, 'attemptEventId') ||
          Object.hasOwn(value, 'outcome') ||
          Object.hasOwn(value, 'evaluationEventId')
        ) {
          pushIssue(errors, '/resolutionKind', 'full solution resolution accepts only reveal ref');
        }
      } else {
        pushIssue(errors, '/resolutionKind', 'unknown original resolution kind');
      }
    } else {
      validateIdentifier(value.attemptEventId, '/attemptEventId', errors);
      const hasOutcome = Object.hasOwn(value, 'outcome');
      const hasFullSolution = Object.hasOwn(value, 'fullSolutionEventId');
      if (hasOutcome === hasFullSolution) {
        pushIssue(
          errors,
          '/outcome',
          'legacy original resolution requires exactly one outcome or full solution ref',
        );
      }
      if (hasOutcome) validateOutcome(value.outcome, '/outcome', errors);
      if (hasFullSolution) {
        validateIdentifier(value.fullSolutionEventId, '/fullSolutionEventId', errors);
      }
    }
  } else if (eventType === 'transfer_question_assigned') {
    validateIdentifier(value.originalResolvedEventId, '/originalResolvedEventId', errors);
    validateIdentifier(value.transferQuestionId, '/transferQuestionId', errors);
    validateKnowledgePointIds(value.knowledgePointIds, '/knowledgePointIds', errors);
    validateIdentifier(value.validationRef, '/validationRef', errors);
    validateTransferAssignmentExtension(value, errors);
  } else if (eventType === 'transfer_answer_submitted') {
    if (value.phase !== 'transfer') pushIssue(errors, '/phase', 'transfer attempt phase required');
    validateIdentifier(value.transferQuestionId, '/transferQuestionId', errors);
    validateTrustedText(value.studentResponse, '/studentResponse', errors);
  } else if (eventType === 'transfer_answer_evaluated') {
    validateIdentifier(value.transferQuestionId, '/transferQuestionId', errors);
    validateIdentifier(value.submissionEventId, '/submissionEventId', errors);
    if (value.outcome !== 'correct' && value.outcome !== 'incorrect') {
      pushIssue(errors, '/outcome', 'transfer outcome must be correct or incorrect');
    }
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
