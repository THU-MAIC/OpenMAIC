import {
  assertValidation,
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  validateIsoDateTime,
  validateNonEmptyString,
  type DomainValidationIssue,
  type DomainValidationResult,
} from './validation';

export const STUDY_ATTEMPT_SCHEMA_VERSION_V1 = 1 as const;
export const STUDY_ATTEMPT_SCHEMA_VERSION_V2 = 2 as const;
// Retained for callers that explicitly construct the legacy v1 contract.
export const STUDY_ATTEMPT_SCHEMA_VERSION = STUDY_ATTEMPT_SCHEMA_VERSION_V1;
export const STUDY_ATTEMPT_CONFLICT_CODE = 'ZHONGKAO_STUDY_ATTEMPT_CONFLICT' as const;

export type QuestionSourceType = 'typed' | 'material' | 'diagnostic' | 'generated';
export type AttemptKind = 'initial' | 'transfer' | 'review';
export type AttemptOutcome = 'correct' | 'incorrect' | 'partial' | 'skipped';
export type StudyAttemptUnassessedReason = 'unsupported_question_type';
export type ErrorType =
  | 'concept'
  | 'method'
  | 'calculation'
  | 'reading'
  | 'expression'
  | 'careless'
  | 'time';

export interface StudyAttemptCommon {
  id: string;
  profileId: string;
  createdAt: string;
  subjectId: string;
  knowledgePointIds: string[];
  questionSummary: string;
  questionSourceType: QuestionSourceType;
  sourceMaterialId?: string;
  sourcePage?: number;
  attemptKind: AttemptKind;
  studentAttemptedBeforeHelp: boolean;
  hintsUsed: number;
  usedKeyHint: boolean;
  viewedFullAnswer: boolean;
  errorType?: ErrorType;
  durationSeconds?: number;
}

export interface StudyAttemptV1 extends StudyAttemptCommon {
  schemaVersion: typeof STUDY_ATTEMPT_SCHEMA_VERSION_V1;
  initialOutcome: AttemptOutcome;
  finalOutcome: AttemptOutcome;
}

export interface StudyAttemptV2Common extends StudyAttemptCommon {
  schemaVersion: typeof STUDY_ATTEMPT_SCHEMA_VERSION_V2;
  coachSessionId: string;
}

export interface EvaluatedStudyAttemptV2 extends StudyAttemptV2Common {
  assessmentStatus: 'evaluated';
  initialOutcome: AttemptOutcome;
  finalOutcome: AttemptOutcome;
}

export type UnassessedStudyAttemptV2 = Omit<StudyAttemptV2Common, 'attemptKind'> & {
  attemptKind: 'initial';
  assessmentStatus: 'unassessed';
  unassessedReason: StudyAttemptUnassessedReason;
};

export type StudyAttemptV2 = EvaluatedStudyAttemptV2 | UnassessedStudyAttemptV2;
export type StudyAttempt = StudyAttemptV1 | StudyAttemptV2;
export type EvaluatedStudyAttempt = StudyAttemptV1 | EvaluatedStudyAttemptV2;

const QUESTION_SOURCE_TYPES = new Set<QuestionSourceType>([
  'typed',
  'material',
  'diagnostic',
  'generated',
]);
const ATTEMPT_KINDS = new Set<AttemptKind>(['initial', 'transfer', 'review']);
const ATTEMPT_OUTCOMES = new Set<AttemptOutcome>(['correct', 'incorrect', 'partial', 'skipped']);
const ASSESSMENT_STATUSES = new Set<StudyAttemptV2['assessmentStatus']>([
  'evaluated',
  'unassessed',
]);
const UNASSESSED_REASONS = new Set<StudyAttemptUnassessedReason>(['unsupported_question_type']);
const ERROR_TYPES = new Set<ErrorType>([
  'concept',
  'method',
  'calculation',
  'reading',
  'expression',
  'careless',
  'time',
]);
const STUDY_ATTEMPT_COMMON_KEYS = [
  'schemaVersion',
  'id',
  'profileId',
  'createdAt',
  'subjectId',
  'knowledgePointIds',
  'questionSummary',
  'questionSourceType',
  'sourceMaterialId',
  'sourcePage',
  'attemptKind',
  'studentAttemptedBeforeHelp',
  'hintsUsed',
  'usedKeyHint',
  'viewedFullAnswer',
  'errorType',
  'durationSeconds',
] as const;
const STUDY_ATTEMPT_V1_KEYS = new Set([
  ...STUDY_ATTEMPT_COMMON_KEYS,
  'initialOutcome',
  'finalOutcome',
]);
const STUDY_ATTEMPT_V2_EVALUATED_KEYS = new Set([
  ...STUDY_ATTEMPT_COMMON_KEYS,
  'coachSessionId',
  'assessmentStatus',
  'initialOutcome',
  'finalOutcome',
]);
const STUDY_ATTEMPT_V2_UNASSESSED_KEYS = new Set([
  ...STUDY_ATTEMPT_COMMON_KEYS,
  'coachSessionId',
  'assessmentStatus',
  'unassessedReason',
]);
const STUDY_ATTEMPT_V2_UNRESOLVED_KEYS = new Set([
  ...STUDY_ATTEMPT_V2_EVALUATED_KEYS,
  'unassessedReason',
]);

function validateEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  path: string,
  errors: DomainValidationIssue[],
): value is T {
  if (typeof value !== 'string' || ![...allowed].some((candidate) => candidate === value)) {
    pushIssue(errors, path, 'unknown enum value');
    return false;
  }
  return true;
}

function validateBoolean(value: unknown, path: string, errors: DomainValidationIssue[]): void {
  if (typeof value !== 'boolean') pushIssue(errors, path, 'expected boolean');
}

export function validateStudyAttempt(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    return { valid: false, errors: [{ path: '/', message: 'expected StudyAttempt object' }] };
  }

  const allowedKeys =
    value.schemaVersion === STUDY_ATTEMPT_SCHEMA_VERSION_V1
      ? STUDY_ATTEMPT_V1_KEYS
      : value.schemaVersion === STUDY_ATTEMPT_SCHEMA_VERSION_V2 &&
          value.assessmentStatus === 'evaluated'
        ? STUDY_ATTEMPT_V2_EVALUATED_KEYS
        : value.schemaVersion === STUDY_ATTEMPT_SCHEMA_VERSION_V2 &&
            value.assessmentStatus === 'unassessed'
          ? STUDY_ATTEMPT_V2_UNASSESSED_KEYS
          : STUDY_ATTEMPT_V2_UNRESOLVED_KEYS;
  rejectUnknownKeys(value, allowedKeys, '', errors);
  if (Object.hasOwn(value, 'isIndependent')) {
    pushIssue(errors, '/isIndependent', 'client-declared independence is forbidden');
  }

  if (
    value.schemaVersion !== STUDY_ATTEMPT_SCHEMA_VERSION_V1 &&
    value.schemaVersion !== STUDY_ATTEMPT_SCHEMA_VERSION_V2
  ) {
    pushIssue(errors, '/schemaVersion', 'expected 1 or 2');
  }
  validateIdentifier(value.id, '/id', errors);
  validateIdentifier(value.profileId, '/profileId', errors);
  validateIsoDateTime(value.createdAt, '/createdAt', errors);
  validateIdentifier(value.subjectId, '/subjectId', errors);
  validateNonEmptyString(value.questionSummary, '/questionSummary', errors);

  if (!Array.isArray(value.knowledgePointIds) || value.knowledgePointIds.length === 0) {
    pushIssue(errors, '/knowledgePointIds', 'expected at least one knowledge point id');
  } else {
    const seen = new Set<string>();
    value.knowledgePointIds.forEach((knowledgePointId, index) => {
      if (validateIdentifier(knowledgePointId, `/knowledgePointIds/${index}`, errors)) {
        if (seen.has(knowledgePointId)) {
          pushIssue(errors, `/knowledgePointIds/${index}`, 'duplicate knowledge point id');
        }
        seen.add(knowledgePointId);
      }
    });
  }

  const sourceTypeValid = validateEnum(
    value.questionSourceType,
    QUESTION_SOURCE_TYPES,
    '/questionSourceType',
    errors,
  );
  if (Object.hasOwn(value, 'sourceMaterialId')) {
    validateIdentifier(value.sourceMaterialId, '/sourceMaterialId', errors);
  }
  if (
    sourceTypeValid &&
    value.questionSourceType === 'material' &&
    !Object.hasOwn(value, 'sourceMaterialId')
  ) {
    pushIssue(errors, '/sourceMaterialId', 'material source requires sourceMaterialId');
  }
  if (Object.hasOwn(value, 'sourcePage')) {
    if (
      typeof value.sourcePage !== 'number' ||
      !Number.isInteger(value.sourcePage) ||
      value.sourcePage <= 0
    ) {
      pushIssue(errors, '/sourcePage', 'expected positive integer');
    }
  }

  validateEnum(value.attemptKind, ATTEMPT_KINDS, '/attemptKind', errors);
  if (value.schemaVersion === STUDY_ATTEMPT_SCHEMA_VERSION_V1) {
    validateEnum(value.initialOutcome, ATTEMPT_OUTCOMES, '/initialOutcome', errors);
    validateEnum(value.finalOutcome, ATTEMPT_OUTCOMES, '/finalOutcome', errors);
  } else if (value.schemaVersion === STUDY_ATTEMPT_SCHEMA_VERSION_V2) {
    validateIdentifier(value.coachSessionId, '/coachSessionId', errors);
    if (validateEnum(value.assessmentStatus, ASSESSMENT_STATUSES, '/assessmentStatus', errors)) {
      if (value.assessmentStatus === 'evaluated') {
        validateEnum(value.initialOutcome, ATTEMPT_OUTCOMES, '/initialOutcome', errors);
        validateEnum(value.finalOutcome, ATTEMPT_OUTCOMES, '/finalOutcome', errors);
      } else {
        validateEnum(value.unassessedReason, UNASSESSED_REASONS, '/unassessedReason', errors);
        if (value.attemptKind !== 'initial') {
          pushIssue(errors, '/attemptKind', 'unassessed attempts must be initial');
        }
      }
    }
  }
  validateBoolean(value.studentAttemptedBeforeHelp, '/studentAttemptedBeforeHelp', errors);
  if (
    typeof value.hintsUsed !== 'number' ||
    !Number.isInteger(value.hintsUsed) ||
    value.hintsUsed < 0
  ) {
    pushIssue(errors, '/hintsUsed', 'expected non-negative integer');
  }
  validateBoolean(value.usedKeyHint, '/usedKeyHint', errors);
  validateBoolean(value.viewedFullAnswer, '/viewedFullAnswer', errors);

  if (Object.hasOwn(value, 'errorType')) {
    validateEnum(value.errorType, ERROR_TYPES, '/errorType', errors);
  }
  if (Object.hasOwn(value, 'durationSeconds')) {
    if (
      typeof value.durationSeconds !== 'number' ||
      !Number.isFinite(value.durationSeconds) ||
      value.durationSeconds < 0
    ) {
      pushIssue(errors, '/durationSeconds', 'expected non-negative finite number');
    }
  }

  return finishValidation(errors);
}

export function assertStudyAttempt(value: unknown): asserts value is StudyAttempt {
  assertValidation(validateStudyAttempt(value), 'ZHONGKAO_STUDY_ATTEMPT_INVALID');
}

export function studyAttemptFactsEqual(left: StudyAttempt, right: StudyAttempt): boolean {
  if (left.schemaVersion !== right.schemaVersion) return false;
  const commonFactsEqual =
    left.id === right.id &&
    left.profileId === right.profileId &&
    left.createdAt === right.createdAt &&
    left.subjectId === right.subjectId &&
    left.knowledgePointIds.length === right.knowledgePointIds.length &&
    left.knowledgePointIds.every(
      (knowledgePointId, index) => knowledgePointId === right.knowledgePointIds[index],
    ) &&
    left.questionSummary === right.questionSummary &&
    left.questionSourceType === right.questionSourceType &&
    left.sourceMaterialId === right.sourceMaterialId &&
    left.sourcePage === right.sourcePage &&
    left.attemptKind === right.attemptKind &&
    left.studentAttemptedBeforeHelp === right.studentAttemptedBeforeHelp &&
    left.hintsUsed === right.hintsUsed &&
    left.usedKeyHint === right.usedKeyHint &&
    left.viewedFullAnswer === right.viewedFullAnswer &&
    left.errorType === right.errorType &&
    left.durationSeconds === right.durationSeconds;
  if (!commonFactsEqual) return false;

  if (left.schemaVersion === STUDY_ATTEMPT_SCHEMA_VERSION_V1) {
    if (right.schemaVersion !== STUDY_ATTEMPT_SCHEMA_VERSION_V1) return false;
    return left.initialOutcome === right.initialOutcome && left.finalOutcome === right.finalOutcome;
  }
  if (right.schemaVersion !== STUDY_ATTEMPT_SCHEMA_VERSION_V2) return false;
  if (
    left.coachSessionId !== right.coachSessionId ||
    left.assessmentStatus !== right.assessmentStatus
  ) {
    return false;
  }
  if (left.assessmentStatus === 'evaluated') {
    if (right.assessmentStatus !== 'evaluated') return false;
    return left.initialOutcome === right.initialOutcome && left.finalOutcome === right.finalOutcome;
  }
  if (right.assessmentStatus !== 'unassessed') return false;
  return left.unassessedReason === right.unassessedReason;
}

export function isEvaluatedStudyAttempt(attempt: StudyAttempt): attempt is EvaluatedStudyAttempt {
  return (
    attempt.schemaVersion === STUDY_ATTEMPT_SCHEMA_VERSION_V1 ||
    attempt.assessmentStatus === 'evaluated'
  );
}

export function isIndependentCorrectAttempt(attempt: StudyAttempt): boolean {
  return (
    isEvaluatedStudyAttempt(attempt) &&
    attempt.finalOutcome === 'correct' &&
    (attempt.attemptKind === 'transfer' || attempt.attemptKind === 'review') &&
    attempt.studentAttemptedBeforeHelp &&
    attempt.hintsUsed === 0 &&
    !attempt.usedKeyHint &&
    !attempt.viewedFullAnswer
  );
}

export const isIndependentCorrect = isIndependentCorrectAttempt;

export function isIncorrectObservation(attempt: StudyAttempt): boolean {
  return (
    isEvaluatedStudyAttempt(attempt) &&
    attempt.initialOutcome === 'incorrect' &&
    attempt.studentAttemptedBeforeHelp
  );
}

export function isAssistedCorrectAttempt(attempt: StudyAttempt): boolean {
  return (
    isEvaluatedStudyAttempt(attempt) &&
    attempt.finalOutcome === 'correct' &&
    (!attempt.studentAttemptedBeforeHelp ||
      attempt.hintsUsed > 0 ||
      attempt.usedKeyHint ||
      attempt.viewedFullAnswer)
  );
}
