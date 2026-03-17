import { NextResponse } from 'next/server';

export const API_ERROR_CODES = {
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  MISSING_API_KEY: 'MISSING_API_KEY',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_URL: 'INVALID_URL',
  REDIRECT_NOT_ALLOWED: 'REDIRECT_NOT_ALLOWED',
  CONTENT_SENSITIVE: 'CONTENT_SENSITIVE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  GENERATION_FAILED: 'GENERATION_FAILED',
  TRANSCRIPTION_FAILED: 'TRANSCRIPTION_FAILED',
  PARSE_FAILED: 'PARSE_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export interface ApiErrorBody {
  success: false;
  errorCode: ApiErrorCode;
  error: string;
  details?: string;
}

export function apiError(
  code: ApiErrorCode,
  status: number,
  error: string,
  details?: string,
): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    {
      success: false as const,
      errorCode: code,
      error,
      ...(details ? { details } : {}),
    },
    { status },
  );
}

export function apiSuccess<T extends Record<string, unknown>>(data: T, status = 200): NextResponse {
  return NextResponse.json({ success: true, ...data }, { status });
}
