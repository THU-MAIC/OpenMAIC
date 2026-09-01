import { NextResponse } from 'next/server';

import { ExamError, isExamError, type ExamErrorCode } from '@/lib/zhongkao/exam-errors';

const HTTP_STATUS: Readonly<Record<ExamErrorCode, number>> = {
  EXAM_INPUT_INVALID: 400,
  EXAM_PROFILE_NOT_FOUND: 404,
  EXAM_SOURCE_NOT_FOUND: 404,
  EXAM_SOURCE_UNAVAILABLE: 404,
  EXAM_SOURCE_INTEGRITY_FAILED: 409,
  EXAM_REQUEST_CONFLICT: 409,
  EXAM_SNAPSHOT_FAILED: 500,
  EXAM_SNAPSHOT_INTEGRITY_FAILED: 409,
  EXAM_DOCUMENT_CONFLICT: 409,
  EXAM_EVENT_CONFLICT: 409,
  EXAM_SESSION_CONFLICT: 409,
  EXAM_NOT_FOUND: 404,
  EXAM_DELETE_FAILED: 500,
};

const SAFE_MESSAGE: Readonly<Record<ExamErrorCode, string>> = {
  EXAM_INPUT_INVALID: 'invalid exam request',
  EXAM_PROFILE_NOT_FOUND: 'exam profile was not found',
  EXAM_SOURCE_NOT_FOUND: 'exam source was not found',
  EXAM_SOURCE_UNAVAILABLE: 'exam source is unavailable',
  EXAM_SOURCE_INTEGRITY_FAILED: 'exam source integrity check failed',
  EXAM_REQUEST_CONFLICT: 'exam request conflicts with persisted facts',
  EXAM_SNAPSHOT_FAILED: 'exam snapshot operation failed',
  EXAM_SNAPSHOT_INTEGRITY_FAILED: 'exam snapshot integrity check failed',
  EXAM_DOCUMENT_CONFLICT: 'exam document conflicts with persisted facts',
  EXAM_EVENT_CONFLICT: 'exam event history is invalid',
  EXAM_SESSION_CONFLICT: 'exam session changed concurrently',
  EXAM_NOT_FOUND: 'exam was not found',
  EXAM_DELETE_FAILED: 'exam deletion failed',
};

export function isExamSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^exam:v1:[a-f0-9]{64}$/u.test(value);
}

export function examNotFound(headers: Headers): NextResponse {
  return new NextResponse('Not found', { status: 404, headers });
}

export function examErrorResponse(error: unknown, headers: Headers): NextResponse {
  const examError = isExamError(error) ? error : new ExamError('EXAM_SESSION_CONFLICT');
  if (examError.code === 'EXAM_NOT_FOUND') {
    return examNotFound(headers);
  }
  return NextResponse.json(
    {
      success: false as const,
      errorCode: examError.code,
      error: SAFE_MESSAGE[examError.code],
    },
    { status: HTTP_STATUS[examError.code], headers },
  );
}
