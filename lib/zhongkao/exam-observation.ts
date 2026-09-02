import { createHash } from 'node:crypto';

import {
  assertValidation,
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  validateIsoDateTime,
  type DomainValidationIssue,
  type DomainValidationResult,
} from './validation';

export const CONFIRMED_EXAM_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const CONFIRMED_EXAM_OBSERVATION_CONFLICT_CODE =
  'ZHONGKAO_CONFIRMED_EXAM_OBSERVATION_CONFLICT' as const;

export const CONFIRMED_EXAM_OBSERVATION_LIMITS = Object.freeze({
  maxKnowledgePointIds: 64,
  maxSerializedBytes: 64 * 1024,
});

export type ConfirmedExamObservationMappingSource = 'owner_confirmed_manual_mapping';
export type ConfirmedExamObservationOutcome = 'correct' | 'incorrect';
export type ConfirmedExamObservationUnassessedReason = 'unsupported_question_type';

interface ConfirmedExamObservationBaseV1 {
  schemaVersion: typeof CONFIRMED_EXAM_OBSERVATION_SCHEMA_VERSION;
  observationId: string;
  profileId: string;
  examSessionId: string;
  confirmedQuestionId: string;
  subjectId: string;
  knowledgePointIds: string[];
  occasionId: string;
  observedAt: string;
  mappingSource: ConfirmedExamObservationMappingSource;
}

export type ConfirmedExamObservationV1 =
  | (ConfirmedExamObservationBaseV1 & {
      assessmentStatus: 'evaluated';
      outcome: ConfirmedExamObservationOutcome;
    })
  | (ConfirmedExamObservationBaseV1 & {
      assessmentStatus: 'unassessed';
      reason: ConfirmedExamObservationUnassessedReason;
    });

export interface DeriveConfirmedExamObservationIdInput {
  examSessionId: string;
  confirmedQuestionId: string;
  mappingFingerprint: string;
  assessmentFingerprint: string;
}

const BASE_KEYS = [
  'schemaVersion',
  'observationId',
  'profileId',
  'examSessionId',
  'confirmedQuestionId',
  'subjectId',
  'knowledgePointIds',
  'occasionId',
  'observedAt',
  'mappingSource',
  'assessmentStatus',
] as const;
const EVALUATED_KEYS = new Set([...BASE_KEYS, 'outcome']);
const UNASSESSED_KEYS = new Set([...BASE_KEYS, 'reason']);
const UNRESOLVED_KEYS = new Set([...BASE_KEYS, 'outcome', 'reason']);

function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\0')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

export function deriveConfirmedExamObservationId(
  input: DeriveConfirmedExamObservationIdInput,
): string {
  const hash = digest('openmaic:zhongkao:confirmed-exam-observation:v1', [
    ['schemaVersion', CONFIRMED_EXAM_OBSERVATION_SCHEMA_VERSION],
    ['examSessionId', input.examSessionId],
    ['confirmedQuestionId', input.confirmedQuestionId],
    ['mappingFingerprint', input.mappingFingerprint],
    ['assessmentFingerprint', input.assessmentFingerprint],
  ]);
  return `exam-observation:v1:${hash}`;
}

export function deriveExamObservationOccasionId(examSessionId: string): string {
  const hash = digest('openmaic:zhongkao:exam-observation-occasion:v1', [
    ['schemaVersion', CONFIRMED_EXAM_OBSERVATION_SCHEMA_VERSION],
    ['examSessionId', examSessionId],
  ]);
  return `exam-occasion:v1:${hash}`;
}

function validateKnowledgePointIds(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > CONFIRMED_EXAM_OBSERVATION_LIMITS.maxKnowledgePointIds
  ) {
    pushIssue(errors, path, 'expected a bounded non-empty knowledge point id array');
    return;
  }
  const seen = new Set<string>();
  value.forEach((knowledgePointId, index) => {
    if (validateIdentifier(knowledgePointId, `${path}/${index}`, errors)) {
      if (seen.has(knowledgePointId)) {
        pushIssue(errors, `${path}/${index}`, 'duplicate knowledge point id');
      }
      seen.add(knowledgePointId);
    }
  });
}

export function validateConfirmedExamObservation(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    return {
      valid: false,
      errors: [{ path: '/', message: 'expected ConfirmedExamObservation object' }],
    };
  }

  const allowedKeys =
    value.assessmentStatus === 'evaluated'
      ? EVALUATED_KEYS
      : value.assessmentStatus === 'unassessed'
        ? UNASSESSED_KEYS
        : UNRESOLVED_KEYS;
  rejectUnknownKeys(value, allowedKeys, '', errors);

  if (value.schemaVersion !== CONFIRMED_EXAM_OBSERVATION_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', 'expected 1');
  }
  validateIdentifier(value.observationId, '/observationId', errors);
  validateIdentifier(value.profileId, '/profileId', errors);
  validateIdentifier(value.examSessionId, '/examSessionId', errors);
  validateIdentifier(value.confirmedQuestionId, '/confirmedQuestionId', errors);
  validateIdentifier(value.subjectId, '/subjectId', errors);
  validateKnowledgePointIds(value.knowledgePointIds, '/knowledgePointIds', errors);
  validateIdentifier(value.occasionId, '/occasionId', errors);
  validateIsoDateTime(value.observedAt, '/observedAt', errors);

  if (value.mappingSource !== 'owner_confirmed_manual_mapping') {
    pushIssue(errors, '/mappingSource', 'unknown mapping source');
  }
  if (value.assessmentStatus === 'evaluated') {
    if (value.outcome !== 'correct' && value.outcome !== 'incorrect') {
      pushIssue(errors, '/outcome', 'unknown evaluated outcome');
    }
  } else if (value.assessmentStatus === 'unassessed') {
    if (value.reason !== 'unsupported_question_type') {
      pushIssue(errors, '/reason', 'unknown unassessed reason');
    }
  } else {
    pushIssue(errors, '/assessmentStatus', 'unknown assessment status');
  }

  if (
    typeof value.examSessionId === 'string' &&
    value.occasionId !== deriveExamObservationOccasionId(value.examSessionId)
  ) {
    pushIssue(errors, '/occasionId', 'occasion id mismatch');
  }

  return finishValidation(errors);
}

export function assertConfirmedExamObservation(
  value: unknown,
): asserts value is ConfirmedExamObservationV1 {
  assertValidation(
    validateConfirmedExamObservation(value),
    'ZHONGKAO_CONFIRMED_EXAM_OBSERVATION_INVALID',
  );
}

function canonicalObservation(observation: ConfirmedExamObservationV1): ConfirmedExamObservationV1 {
  const base: ConfirmedExamObservationBaseV1 = {
    schemaVersion: CONFIRMED_EXAM_OBSERVATION_SCHEMA_VERSION,
    observationId: observation.observationId,
    profileId: observation.profileId,
    examSessionId: observation.examSessionId,
    confirmedQuestionId: observation.confirmedQuestionId,
    subjectId: observation.subjectId,
    knowledgePointIds: [...observation.knowledgePointIds].sort(),
    occasionId: observation.occasionId,
    observedAt: observation.observedAt,
    mappingSource: observation.mappingSource,
  };
  return observation.assessmentStatus === 'evaluated'
    ? {
        ...base,
        assessmentStatus: observation.assessmentStatus,
        outcome: observation.outcome,
      }
    : {
        ...base,
        assessmentStatus: observation.assessmentStatus,
        reason: observation.reason,
      };
}

export function serializeConfirmedExamObservation(value: unknown): Buffer {
  assertConfirmedExamObservation(value);
  const bytes = Buffer.from(JSON.stringify(canonicalObservation(value)), 'utf8');
  if (bytes.byteLength > CONFIRMED_EXAM_OBSERVATION_LIMITS.maxSerializedBytes) {
    throw new Error('ZHONGKAO_CONFIRMED_EXAM_OBSERVATION_INVALID: serialized value too large');
  }
  return bytes;
}

export function confirmedExamObservationFactsEqual(
  left: ConfirmedExamObservationV1,
  right: ConfirmedExamObservationV1,
): boolean {
  return serializeConfirmedExamObservation(left).equals(serializeConfirmedExamObservation(right));
}
