import {
  EXAM_DISPLAY_NAME_MAX_LENGTH,
  EXAM_DOCUMENT_ROLES,
  EXAM_MAX_DOCUMENTS,
  EXAM_MAX_DOCUMENT_BYTES,
  EXAM_MAX_TOTAL_BYTES,
  EXAM_TITLE_MAX_LENGTH,
  compareExamDocumentRoles,
  isExamDocumentRole,
  isExamOwnerMaterialId,
  isExamSupportedMimeType,
  type ExamDocumentRole,
  type ExamSupportedMimeType,
} from './exam';
import { ExamError } from './exam-errors';
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

export const EXAM_EVENT_SCHEMA_VERSION = 1 as const;
export const EXAM_OPERATION_FINGERPRINT_LENGTH = 64;

export interface ExamCreatedDocument {
  examDocumentId: string;
  role: ExamDocumentRole;
  ownerMaterialId: string;
  sourceSha256: string;
  mimeType: ExamSupportedMimeType;
  byteLength: number;
  displayName?: string;
}

interface ExamEventBase {
  schemaVersion: typeof EXAM_EVENT_SCHEMA_VERSION;
  eventId: string;
  examSessionId: string;
  profileId: string;
  eventType: ExamEventType;
  createdAt: string;
  operationId: string;
  operationFingerprint: string;
}

export interface ExamCreatedEvent extends ExamEventBase {
  eventType: 'exam_created';
  subjectId: string;
  title?: string;
  requestFingerprint: string;
  documentSetFingerprint: string;
  documents: readonly ExamCreatedDocument[];
}

export interface ExamDocumentSnapshottedEvent extends ExamEventBase {
  eventType: 'exam_document_snapshotted';
  examDocumentId: string;
  snapshotSha256: string;
  byteLength: number;
}

export interface ExamIntakeCompletedEvent extends ExamEventBase {
  eventType: 'exam_intake_completed';
  documentSetFingerprint: string;
}

export interface ExamDeleteRequestedEvent extends ExamEventBase {
  eventType: 'exam_delete_requested';
  documentSetFingerprint: string;
}

export interface ExamDeletedEvent extends ExamEventBase {
  eventType: 'exam_deleted';
  documentSetFingerprint: string;
  deleteRequestEventId: string;
}

export type ExamEvent =
  | ExamCreatedEvent
  | ExamDocumentSnapshottedEvent
  | ExamIntakeCompletedEvent
  | ExamDeleteRequestedEvent
  | ExamDeletedEvent;

export type ExamEventType = ExamEvent['eventType'];

export const EXAM_EVENT_TYPES = [
  'exam_created',
  'exam_document_snapshotted',
  'exam_intake_completed',
  'exam_delete_requested',
  'exam_deleted',
] as const satisfies readonly ExamEventType[];

const COMMON_KEYS = [
  'schemaVersion',
  'eventId',
  'examSessionId',
  'profileId',
  'eventType',
  'createdAt',
  'operationId',
  'operationFingerprint',
] as const;

const EVENT_KEYS: Readonly<Record<ExamEventType, ReadonlySet<string>>> = {
  exam_created: new Set([
    ...COMMON_KEYS,
    'subjectId',
    'title',
    'requestFingerprint',
    'documentSetFingerprint',
    'documents',
  ]),
  exam_document_snapshotted: new Set([
    ...COMMON_KEYS,
    'examDocumentId',
    'snapshotSha256',
    'byteLength',
  ]),
  exam_intake_completed: new Set([...COMMON_KEYS, 'documentSetFingerprint']),
  exam_delete_requested: new Set([...COMMON_KEYS, 'documentSetFingerprint']),
  exam_deleted: new Set([...COMMON_KEYS, 'documentSetFingerprint', 'deleteRequestEventId']),
};

const CREATED_DOCUMENT_KEYS = new Set([
  'examDocumentId',
  'role',
  'ownerMaterialId',
  'sourceSha256',
  'mimeType',
  'byteLength',
  'displayName',
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

function isExamEventType(value: unknown): value is ExamEventType {
  return (EXAM_EVENT_TYPES as readonly unknown[]).includes(value);
}

function validateSha256(value: unknown, path: string, errors: DomainValidationIssue[]): void {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    pushIssue(errors, path, 'expected lowercase SHA-256 digest');
  }
}

function validateByteLength(value: unknown, path: string, errors: DomainValidationIssue[]): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    pushIssue(errors, path, 'expected positive safe byte length');
    return;
  }
  if ((value as number) > EXAM_MAX_DOCUMENT_BYTES) {
    pushIssue(errors, path, `byte length exceeds ${EXAM_MAX_DOCUMENT_BYTES}`);
  }
}

function validateSafeDisplayText(
  value: unknown,
  path: string,
  maxLength: number,
  errors: DomainValidationIssue[],
): void {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    pushIssue(errors, path, 'expected non-empty trimmed display text');
    return;
  }
  if (value.length > maxLength) pushIssue(errors, path, `text exceeds ${maxLength} characters`);
  if (CONTROL_CHARACTER.test(value) || UNPAIRED_SURROGATE.test(value)) {
    pushIssue(errors, path, 'display text contains an unsafe character');
  }
}

function validateCreatedDocuments(value: unknown, errors: DomainValidationIssue[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > EXAM_MAX_DOCUMENTS) {
    pushIssue(errors, '/documents', `expected 1 to ${EXAM_MAX_DOCUMENTS} created documents`);
    return;
  }

  const roles = new Set<ExamDocumentRole>();
  const documentIds = new Set<string>();
  let previousRole: ExamDocumentRole | undefined;
  let totalBytes = 0;
  value.forEach((raw, index) => {
    const path = `/documents/${index}`;
    if (!isPlainRecord(raw)) {
      pushIssue(errors, path, 'expected created document object');
      return;
    }
    rejectUnknownKeys(raw, CREATED_DOCUMENT_KEYS, path, errors);
    if (validateIdentifier(raw.examDocumentId, `${path}/examDocumentId`, errors)) {
      if (documentIds.has(raw.examDocumentId)) {
        pushIssue(errors, `${path}/examDocumentId`, 'duplicate exam document id');
      }
      documentIds.add(raw.examDocumentId);
    }
    if (!isExamDocumentRole(raw.role)) {
      pushIssue(errors, `${path}/role`, 'unknown exam document role');
    } else {
      if (roles.has(raw.role)) pushIssue(errors, `${path}/role`, 'duplicate exam document role');
      if (previousRole !== undefined && compareExamDocumentRoles(previousRole, raw.role) >= 0) {
        pushIssue(errors, `${path}/role`, 'exam documents must use canonical role order');
      }
      roles.add(raw.role);
      previousRole = raw.role;
    }
    if (!isExamOwnerMaterialId(raw.ownerMaterialId)) {
      pushIssue(errors, `${path}/ownerMaterialId`, 'expected owner material id');
    }
    validateSha256(raw.sourceSha256, `${path}/sourceSha256`, errors);
    if (!isExamSupportedMimeType(raw.mimeType)) {
      pushIssue(errors, `${path}/mimeType`, 'unsupported exam document MIME type');
    }
    validateByteLength(raw.byteLength, `${path}/byteLength`, errors);
    if (Number.isSafeInteger(raw.byteLength) && (raw.byteLength as number) > 0) {
      totalBytes += raw.byteLength as number;
    }
    if (Object.hasOwn(raw, 'displayName')) {
      validateSafeDisplayText(
        raw.displayName,
        `${path}/displayName`,
        EXAM_DISPLAY_NAME_MAX_LENGTH,
        errors,
      );
    }
  });

  if (!roles.has(EXAM_DOCUMENT_ROLES[0])) {
    pushIssue(errors, '/documents', 'exactly one question_paper is required');
  }
  if (totalBytes > EXAM_MAX_TOTAL_BYTES) {
    pushIssue(errors, '/documents', `total bytes exceed ${EXAM_MAX_TOTAL_BYTES}`);
  }
}

function validateCommon(value: Record<string, unknown>, errors: DomainValidationIssue[]): void {
  if (value.schemaVersion !== EXAM_EVENT_SCHEMA_VERSION) {
    pushIssue(errors, '/schemaVersion', `expected schemaVersion ${EXAM_EVENT_SCHEMA_VERSION}`);
  }
  validateIdentifier(value.eventId, '/eventId', errors);
  validateIdentifier(value.examSessionId, '/examSessionId', errors);
  validateIdentifier(value.profileId, '/profileId', errors);
  validateIsoDateTime(value.createdAt, '/createdAt', errors);
  validateIdentifier(value.operationId, '/operationId', errors);
  validateSha256(value.operationFingerprint, '/operationFingerprint', errors);
}

export function validateExamEvent(value: unknown): DomainValidationResult {
  const errors: DomainValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    pushIssue(errors, '', 'expected exam event object');
    return finishValidation(errors);
  }
  if (!isExamEventType(value.eventType)) {
    pushIssue(errors, '/eventType', 'unknown exam event type');
    return finishValidation(errors);
  }

  rejectUnknownKeys(value, EVENT_KEYS[value.eventType], '', errors);
  validateCommon(value, errors);
  switch (value.eventType) {
    case 'exam_created':
      validateIdentifier(value.subjectId, '/subjectId', errors);
      if (Object.hasOwn(value, 'title')) {
        validateSafeDisplayText(value.title, '/title', EXAM_TITLE_MAX_LENGTH, errors);
      }
      validateSha256(value.requestFingerprint, '/requestFingerprint', errors);
      validateSha256(value.documentSetFingerprint, '/documentSetFingerprint', errors);
      validateCreatedDocuments(value.documents, errors);
      break;
    case 'exam_document_snapshotted':
      validateIdentifier(value.examDocumentId, '/examDocumentId', errors);
      validateSha256(value.snapshotSha256, '/snapshotSha256', errors);
      validateByteLength(value.byteLength, '/byteLength', errors);
      break;
    case 'exam_intake_completed':
    case 'exam_delete_requested':
      validateSha256(value.documentSetFingerprint, '/documentSetFingerprint', errors);
      break;
    case 'exam_deleted':
      validateSha256(value.documentSetFingerprint, '/documentSetFingerprint', errors);
      validateIdentifier(value.deleteRequestEventId, '/deleteRequestEventId', errors);
      break;
  }
  return finishValidation(errors);
}

export function assertExamEvent(value: unknown): asserts value is ExamEvent {
  if (!validateExamEvent(value).valid) throw new ExamError('EXAM_EVENT_CONFLICT');
}

export function examEventsEqual(left: ExamEvent, right: ExamEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function examCreatedDocumentsEqual(
  left: readonly ExamCreatedDocument[],
  right: readonly ExamCreatedDocument[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
