import type { StudentProfile } from '@/lib/zhongkao/profile';
import {
  finishValidation,
  isPlainRecord,
  rejectUnknownKeys,
  validateIsoDateTime,
  type DomainValidationIssue,
  type DomainValidationResult,
} from '@/lib/zhongkao/validation';

export const TEACHER_STUDENT_ROSTER_KIND = 'teacherStudentRoster';
export const TEACHER_STUDENT_LIMIT = 200;

export interface TeacherStudent {
  profile: StudentProfile;
  archived: boolean;
}

export interface TeacherStudentFields {
  nickname: string;
  grade: number | null;
  examYear: number | null;
  region: string | null;
}

export interface CreateTeacherStudentRequest extends TeacherStudentFields {
  requestId: string;
}

export interface UpdateTeacherStudentRequest extends TeacherStudentFields {
  expectedUpdatedAt: string;
  archived: boolean;
}

export interface TeacherRosterEvent {
  schemaVersion: 1;
  profileId: string;
  requestId: string;
  requestFingerprint: string;
  archived: false;
  createdAt: string;
}

export type TeacherStudentErrorCode =
  | 'TEACHER_STUDENT_INPUT_INVALID'
  | 'TEACHER_STUDENT_NOT_FOUND'
  | 'TEACHER_STUDENT_CONFLICT'
  | 'TEACHER_STUDENT_LIMIT_REACHED'
  | 'TEACHER_STUDENT_STORAGE_CORRUPT'
  | 'TEACHER_STUDENT_UNAVAILABLE'
  | 'TEACHER_STUDENT_ORIGIN_REJECTED';

const ERROR_STATUS: Record<TeacherStudentErrorCode, number> = {
  TEACHER_STUDENT_INPUT_INVALID: 400,
  TEACHER_STUDENT_NOT_FOUND: 404,
  TEACHER_STUDENT_CONFLICT: 409,
  TEACHER_STUDENT_LIMIT_REACHED: 409,
  TEACHER_STUDENT_STORAGE_CORRUPT: 409,
  TEACHER_STUDENT_UNAVAILABLE: 503,
  TEACHER_STUDENT_ORIGIN_REJECTED: 403,
};

export class TeacherStudentError extends Error {
  readonly status: number;

  constructor(readonly code: TeacherStudentErrorCode) {
    super(code);
    this.name = 'TeacherStudentError';
    this.status = ERROR_STATUS[code];
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_ID = /^teacher-student:v1:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\uD800-\uDFFF]/u;
const FIELDS = ['nickname', 'grade', 'examYear', 'region'];
const CREATE_KEYS = new Set([...FIELDS, 'requestId']);
const UPDATE_KEYS = new Set([...FIELDS, 'expectedUpdatedAt', 'archived']);
const EVENT_KEYS = new Set([
  'schemaVersion',
  'profileId',
  'requestId',
  'requestFingerprint',
  'archived',
  'createdAt',
]);

export function isTeacherStudentProfileId(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_ID.test(value);
}

function textValue(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !UNSAFE_TEXT.test(value)
  );
}

function nullableInteger(value: unknown, min: number, max: number): boolean {
  return (
    value === null ||
    (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max)
  );
}

function parseFields(value: Record<string, unknown>): TeacherStudentFields {
  if (
    !textValue(value.nickname, 80) ||
    value.nickname.trim() === '\u540c\u5b66' ||
    !nullableInteger(value.grade, 1, 12) ||
    !nullableInteger(value.examYear, 2000, 2100) ||
    !(value.region === null || textValue(value.region, 100))
  ) {
    throw new TeacherStudentError('TEACHER_STUDENT_INPUT_INVALID');
  }
  return {
    nickname: value.nickname.trim(),
    grade: value.grade as number | null,
    examYear: value.examYear as number | null,
    region: value.region === null ? null : (value.region as string).trim(),
  };
}

function requestObject(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !keys.has(key))) {
    throw new TeacherStudentError('TEACHER_STUDENT_INPUT_INVALID');
  }
  return value;
}

export function parseCreateTeacherStudentRequest(value: unknown): CreateTeacherStudentRequest {
  const input = requestObject(value, CREATE_KEYS);
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) {
    throw new TeacherStudentError('TEACHER_STUDENT_INPUT_INVALID');
  }
  return { requestId: input.requestId.toLowerCase(), ...parseFields(input) };
}

export function parseUpdateTeacherStudentRequest(value: unknown): UpdateTeacherStudentRequest {
  const input = requestObject(value, UPDATE_KEYS);
  const errors: DomainValidationIssue[] = [];
  if (
    !validateIsoDateTime(input.expectedUpdatedAt, '/expectedUpdatedAt', errors) ||
    typeof input.archived !== 'boolean'
  ) {
    throw new TeacherStudentError('TEACHER_STUDENT_INPUT_INVALID');
  }
  return {
    expectedUpdatedAt: input.expectedUpdatedAt,
    archived: input.archived,
    ...parseFields(input),
  };
}

export function validateTeacherRosterEvent(value: unknown): DomainValidationResult {
  if (!isPlainRecord(value)) {
    return { valid: false, errors: [{ path: '/', message: 'expected teacher roster event' }] };
  }
  const errors: DomainValidationIssue[] = [];
  rejectUnknownKeys(value, EVENT_KEYS, '', errors);
  if (value.schemaVersion !== 1) errors.push({ path: '/schemaVersion', message: 'expected 1' });
  if (!isTeacherStudentProfileId(value.profileId)) {
    errors.push({ path: '/profileId', message: 'invalid student id' });
  }
  if (typeof value.requestId !== 'string' || !UUID.test(value.requestId)) {
    errors.push({ path: '/requestId', message: 'expected UUID' });
  }
  if (typeof value.requestFingerprint !== 'string' || !HASH.test(value.requestFingerprint)) {
    errors.push({ path: '/requestFingerprint', message: 'expected SHA-256 fingerprint' });
  }
  if (value.archived !== false) errors.push({ path: '/archived', message: 'expected false' });
  validateIsoDateTime(value.createdAt, '/createdAt', errors);
  return finishValidation(errors);
}
