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
  EXAM_EXTRACTION_NOT_READY: 409,
  EXAM_QUESTION_PAPER_NOT_FOUND: 409,
  EXAM_QUESTION_PAPER_UNSUPPORTED: 415,
  EXAM_TEXT_EXTRACTION_UNAVAILABLE: 422,
  EXAM_DOCUMENT_EXTRACTION_FAILED: 500,
  EXAM_DOCUMENT_ARTIFACT_INVALID: 500,
  EXAM_QUESTION_SEGMENTATION_FAILED: 500,
  EXAM_EXTRACTION_CONFLICT: 409,
  EXAM_EXTRACTION_CORRUPT: 409,
  EXAM_RESPONSES_NOT_READY: 409,
  EXAM_RESPONSE_INPUT_INVALID: 400,
  EXAM_RESPONSE_INPUT_TOO_LARGE: 413,
  EXAM_RESPONSE_CAPTURE_CONFLICT: 409,
  EXAM_RESPONSE_CAPTURE_FAILED: 500,
  EXAM_RESPONSE_ARTIFACT_CORRUPT: 409,
  EXAM_RESPONSE_MATCHING_FAILED: 500,
  EXAM_RESPONSE_MATCHING_CONFLICT: 409,
  EXAM_REVIEW_NOT_READY: 409,
  EXAM_REVIEW_INPUT_INVALID: 400,
  EXAM_REVIEW_INCOMPLETE: 422,
  EXAM_REVIEW_CONFLICT: 409,
  EXAM_REVIEW_SOURCE_CHANGED: 409,
  EXAM_REVIEW_ARTIFACT_CORRUPT: 409,
  EXAM_REVIEW_FAILED: 500,
  EXAM_GRADING_NOT_READY: 409,
  EXAM_ANSWER_KEY_INPUT_INVALID: 400,
  EXAM_ANSWER_KEY_INCOMPLETE: 422,
  EXAM_ANSWER_KEY_CONFLICT: 409,
  EXAM_ANSWER_KEY_ARTIFACT_CORRUPT: 409,
  EXAM_GRADING_FAILED: 500,
  EXAM_GRADING_CONFLICT: 409,
  EXAM_ASSESSMENT_ARTIFACT_CORRUPT: 409,
  EXAM_KNOWLEDGE_MAPPING_NOT_READY: 409,
  EXAM_KNOWLEDGE_MAPPING_INPUT_INVALID: 400,
  EXAM_KNOWLEDGE_MAPPING_INCOMPLETE: 422,
  EXAM_KNOWLEDGE_MAPPING_CONFLICT: 409,
  EXAM_KNOWLEDGE_MAPPING_FAILED: 500,
  EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT: 409,
  EXAM_OBSERVATION_PROJECTION_FAILED: 500,
  EXAM_OBSERVATION_ARTIFACT_CORRUPT: 409,
  EXAM_OBSERVATION_SOURCE_CHANGED: 409,
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
  EXAM_EXTRACTION_NOT_READY: 'exam is not ready for question extraction',
  EXAM_QUESTION_PAPER_NOT_FOUND: 'exam question paper was not found',
  EXAM_QUESTION_PAPER_UNSUPPORTED: 'exam question paper is not supported',
  EXAM_TEXT_EXTRACTION_UNAVAILABLE: 'exam question paper has no usable text layer',
  EXAM_DOCUMENT_EXTRACTION_FAILED: 'exam document extraction failed',
  EXAM_DOCUMENT_ARTIFACT_INVALID: 'exam document artifact is invalid',
  EXAM_QUESTION_SEGMENTATION_FAILED: 'exam question segmentation failed',
  EXAM_EXTRACTION_CONFLICT: 'exam extraction conflicts with persisted facts',
  EXAM_EXTRACTION_CORRUPT: 'exam extraction artifacts failed integrity checks',
  EXAM_RESPONSES_NOT_READY: 'exam is not ready for student responses',
  EXAM_RESPONSE_INPUT_INVALID: 'invalid exam response request',
  EXAM_RESPONSE_INPUT_TOO_LARGE: 'exam response request is too large',
  EXAM_RESPONSE_CAPTURE_CONFLICT: 'exam responses conflict with persisted facts',
  EXAM_RESPONSE_CAPTURE_FAILED: 'exam response capture failed',
  EXAM_RESPONSE_ARTIFACT_CORRUPT: 'exam response artifacts failed integrity checks',
  EXAM_RESPONSE_MATCHING_FAILED: 'exam response matching failed',
  EXAM_RESPONSE_MATCHING_CONFLICT: 'exam response matching conflicts with persisted facts',
  EXAM_REVIEW_NOT_READY: 'exam is not ready for human review',
  EXAM_REVIEW_INPUT_INVALID: 'invalid exam review request',
  EXAM_REVIEW_INCOMPLETE: 'exam review decisions are incomplete',
  EXAM_REVIEW_CONFLICT: 'exam review conflicts with persisted facts',
  EXAM_REVIEW_SOURCE_CHANGED: 'exam review sources changed',
  EXAM_REVIEW_ARTIFACT_CORRUPT: 'exam review artifact failed integrity checks',
  EXAM_REVIEW_FAILED: 'exam review failed',
  EXAM_GRADING_NOT_READY: 'exam is not ready for grading',
  EXAM_ANSWER_KEY_INPUT_INVALID: 'invalid exam answer key request',
  EXAM_ANSWER_KEY_INCOMPLETE: 'exam answer key is incomplete',
  EXAM_ANSWER_KEY_CONFLICT: 'exam answer key conflicts with persisted facts',
  EXAM_ANSWER_KEY_ARTIFACT_CORRUPT: 'exam answer key artifact failed integrity checks',
  EXAM_GRADING_FAILED: 'exam grading failed',
  EXAM_GRADING_CONFLICT: 'exam grading conflicts with persisted facts',
  EXAM_ASSESSMENT_ARTIFACT_CORRUPT: 'exam assessment artifact failed integrity checks',
  EXAM_KNOWLEDGE_MAPPING_NOT_READY: 'exam is not ready for knowledge mapping',
  EXAM_KNOWLEDGE_MAPPING_INPUT_INVALID: 'invalid exam knowledge mapping request',
  EXAM_KNOWLEDGE_MAPPING_INCOMPLETE: 'exam knowledge mapping is incomplete',
  EXAM_KNOWLEDGE_MAPPING_CONFLICT: 'exam knowledge mapping conflicts with persisted facts',
  EXAM_KNOWLEDGE_MAPPING_FAILED: 'exam knowledge mapping failed',
  EXAM_KNOWLEDGE_MAPPING_ARTIFACT_CORRUPT:
    'exam knowledge mapping artifact failed integrity checks',
  EXAM_OBSERVATION_PROJECTION_FAILED: 'exam observation projection failed',
  EXAM_OBSERVATION_ARTIFACT_CORRUPT: 'exam observation artifact failed integrity checks',
  EXAM_OBSERVATION_SOURCE_CHANGED: 'exam observation sources changed',
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
