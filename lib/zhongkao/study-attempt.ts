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

export const STUDY_ATTEMPT_SCHEMA_VERSION = 1 as const;
export const STUDY_ATTEMPT_CONFLICT_CODE = 'ZHONGKAO_STUDY_ATTEMPT_CONFLICT' as const;

export type QuestionSourceType = 'typed' | 'material' | 'diagnostic' | 'generated';
export type AttemptKind = 'initial' | 'transfer' | 'review';
export type AttemptOutcome = 'correct' | 'incorrect' | 'partial' | 'skipped';
export type ErrorType =
  | 'concept'
  | 'method'
  | 'calculation'
  | 'reading'
  | 'expression'
  | 'careless'
  | 'time';

export interface StudyAttempt {
  schemaVersion: typeof STUDY_ATTEMPT_SCHEMA_VERSION;
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
  initialOutcome: AttemptOutcome;
  finalOutcome: AttemptOutcome;
  studentAttemptedBeforeHelp: boolean;
  hintsUsed: number;
  usedKeyHint: boolean;
  viewedFullAnswer: boolean;
  errorType?: ErrorType;
  durationSeconds?: number;
}

const QUESTION_SOURCE_TYPES = new Set<QuestionSourceType>([
  'typed',
  'material',
  'diagnostic',
  'generated',
]);
const ATTEMPT_KINDS = new Set<AttemptKind>(['initial', 'transfer', 'review']);
const ATTEMPT_OUTCOMES = new Set<AttemptOutcome>(['correct', 'incorrect', 'partial', 'skipped']);
const ERROR_TYPES = new Set<ErrorType>([
  'concept',
  'method',
  'calculation',
  'reading',
  'expression',
  'careless',
  'time',
]);
const STUDY_ATTEMPT_KEYS = new Set([
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
  'initialOutcome',
  'finalOutcome',
  'studentAttemptedBeforeHelp',
  'hintsUsed',
  'usedKeyHint',
  'viewedFullAnswer',
  'errorType',
  'durationSeconds',
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

  rejectUnknownKeys(value, STUDY_ATTEMPT_KEYS, '', errors);
  if (Object.hasOwn(value, 'isIndependent')) {
    pushIssue(errors, '/isIndependent', 'client-declared independence is forbidden');
  }

  if (value.schemaVersion !== STUDY_ATTEMPT_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', `expected ${STUDY_ATTEMPT_SCHEMA_VERSION}`);
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
  validateEnum(value.initialOutcome, ATTEMPT_OUTCOMES, '/initialOutcome', errors);
  validateEnum(value.finalOutcome, ATTEMPT_OUTCOMES, '/finalOutcome', errors);
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
  return (
    left.schemaVersion === right.schemaVersion &&
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
    left.initialOutcome === right.initialOutcome &&
    left.finalOutcome === right.finalOutcome &&
    left.studentAttemptedBeforeHelp === right.studentAttemptedBeforeHelp &&
    left.hintsUsed === right.hintsUsed &&
    left.usedKeyHint === right.usedKeyHint &&
    left.viewedFullAnswer === right.viewedFullAnswer &&
    left.errorType === right.errorType &&
    left.durationSeconds === right.durationSeconds
  );
}

export function isIndependentCorrectAttempt(attempt: StudyAttempt): boolean {
  return (
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
  return attempt.initialOutcome === 'incorrect' && attempt.studentAttemptedBeforeHelp;
}

export function isAssistedCorrectAttempt(attempt: StudyAttempt): boolean {
  return (
    attempt.finalOutcome === 'correct' &&
    (!attempt.studentAttemptedBeforeHelp ||
      attempt.hintsUsed > 0 ||
      attempt.usedKeyHint ||
      attempt.viewedFullAnswer)
  );
}
