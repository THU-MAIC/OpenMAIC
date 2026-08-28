import {
  createUnknownField,
  validateObservedField,
  type EvidenceRef,
  type ObservedField,
} from './observed-field';
import {
  assertValidation,
  escapedPointerSegment,
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  validateIsoDateTime,
  validateNonEmptyString,
  type DomainValidationIssue,
  type DomainValidationResult,
  type DomainValueValidator,
} from './validation';

export const STUDENT_PROFILE_SCHEMA_VERSION = 1 as const;

const PROFILE_KEYS = new Set([
  'schemaVersion',
  'profileId',
  'displayName',
  'grade',
  'examYear',
  'region',
  'textbookVersions',
  'baselineScores',
  'targetScores',
  'preferredSubjects',
  'weekdayMinutes',
  'weekendMinutes',
  'createdAt',
  'updatedAt',
]);

const TEXTBOOK_KEYS = new Set(['publisher', 'title', 'volume']);

export interface TextbookVersion {
  publisher: string;
  title: string;
  volume?: string;
}

export interface StudentProfile {
  schemaVersion: typeof STUDENT_PROFILE_SCHEMA_VERSION;
  profileId: string;
  displayName: ObservedField<string>;
  grade: ObservedField<number>;
  examYear: ObservedField<number>;
  region: ObservedField<string>;
  textbookVersions: Record<string, ObservedField<TextbookVersion>>;
  baselineScores: Record<string, ObservedField<number>>;
  targetScores: Record<string, ObservedField<number>>;
  preferredSubjects: ObservedField<readonly string[]>;
  weekdayMinutes: ObservedField<number>;
  weekendMinutes: ObservedField<number>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInitialStudentProfileInput {
  profileId: string;
  createdAt: string;
}

const nonEmptyStringValue: DomainValueValidator = (value, path, errors) => {
  validateNonEmptyString(value, path, errors);
};

const displayNameValue: DomainValueValidator = (value, path, errors) => {
  if (!validateNonEmptyString(value, path, errors)) return;
  if (value.trim() === '\u540c\u5b66') {
    pushIssue(errors, path, 'UI fallback label must not be stored as a name');
  }
};

const positiveIntegerValue: DomainValueValidator = (value, path, errors) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    pushIssue(errors, path, 'expected positive integer');
  }
};

const nonNegativeNumberValue: DomainValueValidator = (value, path, errors) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    pushIssue(errors, path, 'expected non-negative finite number');
  }
};

const nonNegativeIntegerValue: DomainValueValidator = (value, path, errors) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    pushIssue(errors, path, 'expected non-negative integer');
  }
};

const subjectListValue: DomainValueValidator = (value, path, errors) => {
  if (!Array.isArray(value)) {
    pushIssue(errors, path, 'expected subject id array');
    return;
  }
  const seen = new Set<string>();
  value.forEach((subjectId, index) => {
    if (validateIdentifier(subjectId, `${path}/${index}`, errors)) {
      if (seen.has(subjectId)) pushIssue(errors, `${path}/${index}`, 'duplicate subject id');
      seen.add(subjectId);
    }
  });
};

const textbookValue: DomainValueValidator = (value, path, errors) => {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected textbook version object');
    return;
  }

  rejectUnknownKeys(value, TEXTBOOK_KEYS, path, errors);
  validateNonEmptyString(value.publisher, `${path}/publisher`, errors);
  validateNonEmptyString(value.title, `${path}/title`, errors);
  if (Object.hasOwn(value, 'volume')) {
    validateNonEmptyString(value.volume, `${path}/volume`, errors);
  }
};

function appendObservedErrors(
  value: unknown,
  validator: DomainValueValidator,
  path: string,
  errors: DomainValidationIssue[],
): void {
  const result = validateObservedField(value, validator, path);
  if (!result.valid) errors.push(...result.errors);
}

function validateExplicitConfirmationBoundary(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): void {
  if (!isPlainRecord(value) || value.status !== 'confirmed' || !Array.isArray(value.evidence)) {
    return;
  }
  const hasExplicitConfirmation = value.evidence.some(
    (evidence) =>
      isPlainRecord(evidence) &&
      (evidence.type === 'user_input' || evidence.type === 'guardian_input'),
  );
  if (!hasExplicitConfirmation) {
    pushIssue(
      errors,
      `${path}/evidence`,
      'confirmed field requires explicit user/guardian evidence',
    );
  }
  if (
    value.evidence.some((evidence) => isPlainRecord(evidence) && evidence.type === 'project_setup')
  ) {
    pushIssue(errors, `${path}/evidence`, 'project setup evidence is not allowed for this field');
  }
}

function validateFixedProjectSetupFact(
  value: unknown,
  expectedValue: number,
  path: string,
  errors: DomainValidationIssue[],
): void {
  if (!isPlainRecord(value) || value.status !== 'confirmed' || !Array.isArray(value.evidence)) {
    return;
  }
  const hasProjectSetup = value.evidence.some(
    (evidence) => isPlainRecord(evidence) && evidence.type === 'project_setup',
  );
  if (hasProjectSetup && value.value !== expectedValue) {
    pushIssue(errors, `${path}/value`, `project setup value must equal ${expectedValue}`);
  }
}

function validateObservedMap(
  value: unknown,
  validator: DomainValueValidator,
  path: string,
  errors: DomainValidationIssue[],
): void {
  if (!isPlainRecord(value)) {
    pushIssue(errors, path, 'expected subject map');
    return;
  }
  for (const [subjectId, field] of Object.entries(value)) {
    const subjectPath = `${path}/${escapedPointerSegment(subjectId)}`;
    validateIdentifier(subjectId, subjectPath, errors);
    appendObservedErrors(field, validator, subjectPath, errors);
    validateExplicitConfirmationBoundary(field, subjectPath, errors);
  }
}

export function validateStudentProfile(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    return { valid: false, errors: [{ path: '/', message: 'expected StudentProfile object' }] };
  }

  rejectUnknownKeys(value, PROFILE_KEYS, '', errors);
  if (value.schemaVersion !== STUDENT_PROFILE_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', `expected ${STUDENT_PROFILE_SCHEMA_VERSION}`);
  }
  validateIdentifier(value.profileId, '/profileId', errors);
  validateIsoDateTime(value.createdAt, '/createdAt', errors);
  validateIsoDateTime(value.updatedAt, '/updatedAt', errors);
  appendObservedErrors(value.displayName, displayNameValue, '/displayName', errors);
  validateExplicitConfirmationBoundary(value.displayName, '/displayName', errors);
  appendObservedErrors(value.grade, positiveIntegerValue, '/grade', errors);
  validateFixedProjectSetupFact(value.grade, 9, '/grade', errors);
  appendObservedErrors(value.examYear, positiveIntegerValue, '/examYear', errors);
  validateFixedProjectSetupFact(value.examYear, 2027, '/examYear', errors);
  appendObservedErrors(value.region, nonEmptyStringValue, '/region', errors);
  validateExplicitConfirmationBoundary(value.region, '/region', errors);
  validateObservedMap(value.textbookVersions, textbookValue, '/textbookVersions', errors);
  validateObservedMap(value.baselineScores, nonNegativeNumberValue, '/baselineScores', errors);
  validateObservedMap(value.targetScores, nonNegativeNumberValue, '/targetScores', errors);
  appendObservedErrors(value.preferredSubjects, subjectListValue, '/preferredSubjects', errors);
  validateExplicitConfirmationBoundary(value.preferredSubjects, '/preferredSubjects', errors);
  appendObservedErrors(value.weekdayMinutes, nonNegativeIntegerValue, '/weekdayMinutes', errors);
  validateExplicitConfirmationBoundary(value.weekdayMinutes, '/weekdayMinutes', errors);
  appendObservedErrors(value.weekendMinutes, nonNegativeIntegerValue, '/weekendMinutes', errors);
  validateExplicitConfirmationBoundary(value.weekendMinutes, '/weekendMinutes', errors);
  return finishValidation(errors);
}

export function assertStudentProfile(value: unknown): asserts value is StudentProfile {
  assertValidation(validateStudentProfile(value), 'ZHONGKAO_STUDENT_PROFILE_INVALID');
}

function createInitialProjectSetupFacts(
  createdAt: string,
): Pick<StudentProfile, 'grade' | 'examYear'> {
  const gradeEvidence: EvidenceRef = {
    type: 'project_setup',
    description: 'Grade 9 project setup',
    createdAt,
  };
  const examYearEvidence: EvidenceRef = {
    type: 'project_setup',
    description: '2027 exam-year project setup',
    createdAt,
  };
  return {
    grade: {
      value: 9,
      status: 'confirmed',
      confidence: 1,
      evidence: [gradeEvidence],
      updatedAt: createdAt,
    },
    examYear: {
      value: 2027,
      status: 'confirmed',
      confidence: 1,
      evidence: [examYearEvidence],
      updatedAt: createdAt,
    },
  };
}

export function createInitialStudentProfile(
  input: CreateInitialStudentProfileInput,
): StudentProfile {
  const inputErrors: DomainValidationIssue[] = [];
  validateIdentifier(input.profileId, '/profileId', inputErrors);
  validateIsoDateTime(input.createdAt, '/createdAt', inputErrors);
  assertValidation(finishValidation(inputErrors), 'ZHONGKAO_STUDENT_PROFILE_INVALID');
  const projectSetupFacts = createInitialProjectSetupFacts(input.createdAt);

  return {
    schemaVersion: STUDENT_PROFILE_SCHEMA_VERSION,
    profileId: input.profileId,
    displayName: createUnknownField(input.createdAt),
    grade: projectSetupFacts.grade,
    examYear: projectSetupFacts.examYear,
    region: createUnknownField(input.createdAt),
    textbookVersions: {},
    baselineScores: {},
    targetScores: {},
    preferredSubjects: createUnknownField(input.createdAt),
    weekdayMinutes: createUnknownField(input.createdAt),
    weekendMinutes: createUnknownField(input.createdAt),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}
