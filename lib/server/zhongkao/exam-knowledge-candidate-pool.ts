import { createHash } from 'node:crypto';

import {
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  type DomainValidationIssue,
  type DomainValidationResult,
} from '@/lib/zhongkao/validation';

import { collectKnowledgeProgressEvidence } from './progress-evidence-service';
import type { ExamServiceDeps } from './exam-service';

export const EXAM_KNOWLEDGE_CANDIDATE_POOL_SCHEMA_VERSION = 1 as const;
export const EXAM_KNOWLEDGE_CANDIDATE_POOL_VERSION = 1 as const;
export const EXAM_KNOWLEDGE_CANDIDATE_POOL_MAX_IDS = 256;

export type ExamKnowledgeCandidatePoolMode = 'observed_existing_ids' | 'label_only';

export interface ExamKnowledgeCandidatePoolV1 {
  schemaVersion: typeof EXAM_KNOWLEDGE_CANDIDATE_POOL_SCHEMA_VERSION;
  poolVersion: typeof EXAM_KNOWLEDGE_CANDIDATE_POOL_VERSION;
  mode: ExamKnowledgeCandidatePoolMode;
  subjectId: string;
  knowledgePointIds: string[];
  fingerprint: string;
}

export type ExamKnowledgeCandidatePoolErrorCode =
  | 'EXAM_KNOWLEDGE_CANDIDATE_POOL_INVALID'
  | 'EXAM_KNOWLEDGE_CANDIDATE_POOL_EVIDENCE_FAILED';

export class ExamKnowledgeCandidatePoolError extends Error {
  override readonly name = 'ExamKnowledgeCandidatePoolError';

  constructor(readonly code: ExamKnowledgeCandidatePoolErrorCode) {
    super(code);
  }
}

const SHA256 = /^[a-f0-9]{64}$/u;
const POOL_KEYS = new Set([
  'schemaVersion',
  'poolVersion',
  'mode',
  'subjectId',
  'knowledgePointIds',
  'fingerprint',
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function fingerprint(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identifiersAreCanonical(values: readonly string[]): boolean {
  const errors: DomainValidationIssue[] = [];
  values.forEach((value, index) =>
    validateIdentifier(value, `/knowledgePointIds/${index}`, errors),
  );
  return (
    errors.length === 0 &&
    values.length <= EXAM_KNOWLEDGE_CANDIDATE_POOL_MAX_IDS &&
    values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

export function createExamKnowledgeCandidatePoolFingerprint(input: {
  mode: ExamKnowledgeCandidatePoolMode;
  subjectId: string;
  knowledgePointIds: readonly string[];
}): string {
  return fingerprint('openmaic:zhongkao-exam-knowledge-candidate-pool:v1', {
    poolVersion: EXAM_KNOWLEDGE_CANDIDATE_POOL_VERSION,
    mode: input.mode,
    subjectId: input.subjectId,
    knowledgePointIds: input.knowledgePointIds,
  });
}

export const deriveExamKnowledgeCandidatePoolFingerprint =
  createExamKnowledgeCandidatePoolFingerprint;

export function buildExamKnowledgeCandidatePool(input: {
  subjectId: string;
  knowledgePointIds: readonly string[];
}): ExamKnowledgeCandidatePoolV1 {
  const errors: DomainValidationIssue[] = [];
  validateIdentifier(input.subjectId, '/subjectId', errors);
  if (!Array.isArray(input.knowledgePointIds)) {
    pushIssue(errors, '/knowledgePointIds', 'expected knowledge point id array');
  } else {
    input.knowledgePointIds.forEach((value, index) =>
      validateIdentifier(value, `/knowledgePointIds/${index}`, errors),
    );
  }
  if (errors.length > 0) {
    throw new ExamKnowledgeCandidatePoolError('EXAM_KNOWLEDGE_CANDIDATE_POOL_INVALID');
  }

  const knowledgePointIds = [...new Set(input.knowledgePointIds)]
    .sort(compareIds)
    .slice(0, EXAM_KNOWLEDGE_CANDIDATE_POOL_MAX_IDS);
  const mode: ExamKnowledgeCandidatePoolMode =
    knowledgePointIds.length === 0 ? 'label_only' : 'observed_existing_ids';
  const pool: ExamKnowledgeCandidatePoolV1 = {
    schemaVersion: EXAM_KNOWLEDGE_CANDIDATE_POOL_SCHEMA_VERSION,
    poolVersion: EXAM_KNOWLEDGE_CANDIDATE_POOL_VERSION,
    mode,
    subjectId: input.subjectId,
    knowledgePointIds,
    fingerprint: createExamKnowledgeCandidatePoolFingerprint({
      mode,
      subjectId: input.subjectId,
      knowledgePointIds,
    }),
  };
  if (!validateExamKnowledgeCandidatePool(pool).valid) {
    throw new ExamKnowledgeCandidatePoolError('EXAM_KNOWLEDGE_CANDIDATE_POOL_INVALID');
  }
  return pool;
}

export function validateExamKnowledgeCandidatePool(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected knowledge candidate pool object');
    return finishValidation(errors);
  }
  rejectUnknownKeys(value, POOL_KEYS, '', errors);
  if (value.schemaVersion !== EXAM_KNOWLEDGE_CANDIDATE_POOL_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', 'unexpected pool schema version');
  }
  if (value.poolVersion !== EXAM_KNOWLEDGE_CANDIDATE_POOL_VERSION) {
    pushIssue(errors, '/poolVersion', 'unexpected pool version');
  }
  validateIdentifier(value.subjectId, '/subjectId', errors);
  if (value.mode !== 'observed_existing_ids' && value.mode !== 'label_only') {
    pushIssue(errors, '/mode', 'unexpected pool mode');
  }
  if (!Array.isArray(value.knowledgePointIds)) {
    pushIssue(errors, '/knowledgePointIds', 'expected knowledge point id array');
  } else if (!identifiersAreCanonical(value.knowledgePointIds as unknown[] as string[])) {
    pushIssue(
      errors,
      '/knowledgePointIds',
      'knowledge point ids must be unique, sorted, valid, and bounded',
    );
  }
  if (
    value.mode === 'label_only' &&
    Array.isArray(value.knowledgePointIds) &&
    value.knowledgePointIds.length !== 0
  ) {
    pushIssue(errors, '/mode', 'label-only pool must not contain knowledge point ids');
  }
  if (
    value.mode === 'observed_existing_ids' &&
    Array.isArray(value.knowledgePointIds) &&
    value.knowledgePointIds.length === 0
  ) {
    pushIssue(errors, '/mode', 'observed-id pool must contain a knowledge point id');
  }
  if (typeof value.fingerprint !== 'string' || !SHA256.test(value.fingerprint)) {
    pushIssue(errors, '/fingerprint', 'expected lowercase SHA-256');
  }
  if (
    errors.length === 0 &&
    value.fingerprint !==
      createExamKnowledgeCandidatePoolFingerprint({
        mode: value.mode as ExamKnowledgeCandidatePoolMode,
        subjectId: value.subjectId as string,
        knowledgePointIds: value.knowledgePointIds as string[],
      })
  ) {
    pushIssue(errors, '/fingerprint', 'knowledge candidate pool fingerprint mismatch');
  }
  return finishValidation(errors);
}

export function parseExamKnowledgeCandidatePool(value: unknown): ExamKnowledgeCandidatePoolV1 {
  if (!validateExamKnowledgeCandidatePool(value).valid) {
    throw new ExamKnowledgeCandidatePoolError('EXAM_KNOWLEDGE_CANDIDATE_POOL_INVALID');
  }
  const pool = value as ExamKnowledgeCandidatePoolV1;
  return {
    schemaVersion: EXAM_KNOWLEDGE_CANDIDATE_POOL_SCHEMA_VERSION,
    poolVersion: EXAM_KNOWLEDGE_CANDIDATE_POOL_VERSION,
    mode: pool.mode,
    subjectId: pool.subjectId,
    knowledgePointIds: [...pool.knowledgePointIds],
    fingerprint: pool.fingerprint,
  };
}

export async function collectExamKnowledgeCandidatePool(
  deps: ExamServiceDeps,
  profileId: string,
  subjectId: string,
): Promise<ExamKnowledgeCandidatePoolV1> {
  const errors: DomainValidationIssue[] = [];
  validateIdentifier(profileId, '/profileId', errors);
  validateIdentifier(subjectId, '/subjectId', errors);
  if (errors.length > 0) {
    throw new ExamKnowledgeCandidatePoolError('EXAM_KNOWLEDGE_CANDIDATE_POOL_INVALID');
  }

  let collected: Awaited<ReturnType<typeof collectKnowledgeProgressEvidence>>;
  try {
    collected = await collectKnowledgeProgressEvidence(deps, profileId);
  } catch {
    throw new ExamKnowledgeCandidatePoolError('EXAM_KNOWLEDGE_CANDIDATE_POOL_EVIDENCE_FAILED');
  }

  const knowledgePointIds: string[] = [];
  for (const evidence of collected.evidence) {
    if (evidence.sourceKind === 'study_attempt') {
      if (evidence.attempt.subjectId === subjectId) {
        knowledgePointIds.push(...evidence.attempt.knowledgePointIds);
      }
      continue;
    }
    if (evidence.observation.subjectId === subjectId) {
      knowledgePointIds.push(...evidence.observation.knowledgePointIds);
    }
  }
  return buildExamKnowledgeCandidatePool({ subjectId, knowledgePointIds });
}

export const resolveExamKnowledgeCandidatePool = collectExamKnowledgeCandidatePool;
