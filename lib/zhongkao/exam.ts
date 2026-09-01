import { ExamError } from './exam-errors';
import {
  finishValidation,
  isPlainRecord,
  pushIssue,
  rejectUnknownKeys,
  validateIdentifier,
  type DomainValidationIssue,
  type DomainValidationResult,
} from './validation';

export const EXAM_SCHEMA_VERSION = 1 as const;
export const EXAM_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const EXAM_CLIENT_REQUEST_ID_MAX_LENGTH = 128;
export const EXAM_TITLE_MAX_LENGTH = 200;
export const EXAM_DISPLAY_NAME_MAX_LENGTH = 512;
export const EXAM_MAX_DOCUMENTS = 3;
export const EXAM_MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const EXAM_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export const EXAM_DOCUMENT_ROLES = ['question_paper', 'student_response', 'answer_key'] as const;

export type ExamDocumentRole = (typeof EXAM_DOCUMENT_ROLES)[number];

export const EXAM_SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
] as const;

export type ExamSupportedMimeType = (typeof EXAM_SUPPORTED_MIME_TYPES)[number];

export interface ExamCreateDocumentInput {
  role: ExamDocumentRole;
  ownerMaterialId: string;
}

export interface ExamCreateRequest {
  clientRequestId: string;
  profileId: string;
  subjectId: string;
  title?: string;
  documents: readonly ExamCreateDocumentInput[];
}

export interface ExamRequestSemanticFacts {
  schemaVersion: typeof EXAM_SCHEMA_VERSION;
  profileId: string;
  subjectId: string;
  title?: string;
  documents: readonly ExamCreateDocumentInput[];
}

export type PublicExamStatus = 'intake_pending' | 'ready_for_extraction' | 'deleting';
export type PublicExamDocumentSnapshotStatus = 'pending' | 'snapshotted';

export interface PublicExamDocument {
  examDocumentId: string;
  role: ExamDocumentRole;
  displayName?: string;
  mimeType: ExamSupportedMimeType;
  byteLength: number;
  snapshotStatus: PublicExamDocumentSnapshotStatus;
}

export interface PublicExamSession {
  schemaVersion: typeof EXAM_SCHEMA_VERSION;
  examSessionId: string;
  profileId: string;
  subjectId: string;
  title?: string;
  status: PublicExamStatus;
  createdAt: string;
  documents: readonly PublicExamDocument[];
}

const CREATE_REQUEST_KEYS = new Set([
  'clientRequestId',
  'profileId',
  'subjectId',
  'title',
  'documents',
]);
const CREATE_DOCUMENT_KEYS = new Set(['role', 'ownerMaterialId']);
const CLIENT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OWNER_MATERIAL_ID = /^mat_[0-9abcdefghjkmnpqrstvwxyz]{26}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

const ROLE_ORDER: Readonly<Record<ExamDocumentRole, number>> = {
  question_paper: 0,
  student_response: 1,
  answer_key: 2,
};

export function isExamOwnerMaterialId(value: unknown): value is string {
  return typeof value === 'string' && OWNER_MATERIAL_ID.test(value);
}

export function isExamDocumentRole(value: unknown): value is ExamDocumentRole {
  return (EXAM_DOCUMENT_ROLES as readonly unknown[]).includes(value);
}

export function isExamSupportedMimeType(value: unknown): value is ExamSupportedMimeType {
  return (EXAM_SUPPORTED_MIME_TYPES as readonly unknown[]).includes(value);
}

export function compareExamDocumentRoles(left: ExamDocumentRole, right: ExamDocumentRole): number {
  return ROLE_ORDER[left] - ROLE_ORDER[right];
}

export function canonicalizeExamDocuments(
  documents: readonly ExamCreateDocumentInput[],
): ExamCreateDocumentInput[] {
  return documents
    .map((document) => ({ ...document }))
    .sort((left, right) => compareExamDocumentRoles(left.role, right.role));
}

function validateClientRequestId(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): void {
  if (typeof value !== 'string' || !CLIENT_REQUEST_ID.test(value)) {
    pushIssue(
      errors,
      path,
      `expected 1 to ${EXAM_CLIENT_REQUEST_ID_MAX_LENGTH} safe request-id characters`,
    );
  }
}

function validateOwnerMaterialId(
  value: unknown,
  path: string,
  errors: DomainValidationIssue[],
): void {
  if (!isExamOwnerMaterialId(value)) {
    pushIssue(errors, path, 'expected owner material id');
  }
}

function normalizedTitle(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function validateTitle(value: unknown, path: string, errors: DomainValidationIssue[]): void {
  if (typeof value !== 'string') {
    pushIssue(errors, path, 'expected title string');
    return;
  }
  const title = value.trim();
  if (title.length === 0) pushIssue(errors, path, 'title must not be empty');
  if (title.length > EXAM_TITLE_MAX_LENGTH) {
    pushIssue(errors, path, `title exceeds ${EXAM_TITLE_MAX_LENGTH} characters`);
  }
  if (CONTROL_CHARACTER.test(title) || UNPAIRED_SURROGATE.test(title)) {
    pushIssue(errors, path, 'title contains an unsafe character');
  }
}

function validateCreateDocuments(value: unknown, errors: DomainValidationIssue[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > EXAM_MAX_DOCUMENTS) {
    pushIssue(errors, '/documents', `expected 1 to ${EXAM_MAX_DOCUMENTS} documents`);
    return;
  }

  const roles = new Set<ExamDocumentRole>();
  value.forEach((raw, index) => {
    const path = `/documents/${index}`;
    if (!isPlainRecord(raw)) {
      pushIssue(errors, path, 'expected document object');
      return;
    }
    rejectUnknownKeys(raw, CREATE_DOCUMENT_KEYS, path, errors);
    if (!isExamDocumentRole(raw.role)) {
      pushIssue(errors, `${path}/role`, 'unknown exam document role');
    } else if (roles.has(raw.role)) {
      pushIssue(errors, `${path}/role`, 'duplicate exam document role');
    } else {
      roles.add(raw.role);
    }
    validateOwnerMaterialId(raw.ownerMaterialId, `${path}/ownerMaterialId`, errors);
  });

  if (!roles.has('question_paper')) {
    pushIssue(errors, '/documents', 'exactly one question_paper is required');
  }
}

export function validateExamCreateRequest(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected exam create request object');
    return finishValidation(errors);
  }

  rejectUnknownKeys(value, CREATE_REQUEST_KEYS, '', errors);
  validateClientRequestId(value.clientRequestId, '/clientRequestId', errors);
  validateIdentifier(value.profileId, '/profileId', errors);
  validateIdentifier(value.subjectId, '/subjectId', errors);
  if (Object.hasOwn(value, 'title')) validateTitle(value.title, '/title', errors);
  validateCreateDocuments(value.documents, errors);
  return finishValidation(errors);
}

export function parseExamCreateRequest(value: unknown): ExamCreateRequest {
  const result = validateExamCreateRequest(value);
  if (!result.valid) throw new ExamError('EXAM_INPUT_INVALID');
  const input = value as {
    clientRequestId: string;
    profileId: string;
    subjectId: string;
    title?: string;
    documents: ExamCreateDocumentInput[];
  };
  const title = Object.hasOwn(input, 'title') ? normalizedTitle(input.title) : undefined;
  return {
    clientRequestId: input.clientRequestId,
    profileId: input.profileId,
    subjectId: input.subjectId,
    ...(title === undefined ? {} : { title }),
    documents: canonicalizeExamDocuments(input.documents),
  };
}

export function examRequestSemanticFacts(input: ExamCreateRequest): ExamRequestSemanticFacts {
  return {
    schemaVersion: EXAM_SCHEMA_VERSION,
    profileId: input.profileId,
    subjectId: input.subjectId,
    ...(input.title === undefined ? {} : { title: input.title }),
    documents: canonicalizeExamDocuments(input.documents),
  };
}
