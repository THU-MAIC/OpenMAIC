export const COACH_ERROR_CODES = [
  'COACH_INPUT_INVALID',
  'COACH_PROFILE_NOT_FOUND',
  'COACH_SESSION_NOT_FOUND',
  'COACH_SESSION_CONFLICT',
  'COACH_ACTION_NOT_ALLOWED',
  'STUDENT_ATTEMPT_REQUIRED',
  'FULL_SOLUTION_LOCKED',
  'FULL_SOLUTION_REQUEST_REQUIRED',
  'HINT_LIMIT_REACHED',
  'HINT_GENERATION_PENDING',
  'TRANSFER_QUESTION_REQUIRED',
  'COACH_MESSAGE_ALREADY_COUNTED',
  'COACH_EVENT_CONFLICT',
  'COACH_RUNTIME_UNAVAILABLE',
  'MATERIAL_SOURCE_NOT_SUPPORTED',
  'MATERIAL_SOURCE_NOT_VERIFIED',
  'HINT_GENERATION_FAILED',
  'HINT_CONTENT_INVALID',
  'HINT_CONTENT_LEAKED',
  'FULL_SOLUTION_GENERATION_FAILED',
  'FULL_SOLUTION_CONTENT_INVALID',
  'COACH_GENERATION_UNAVAILABLE',
] as const;

export type CoachErrorCode = (typeof COACH_ERROR_CODES)[number];

export class CoachError extends Error {
  override readonly name = 'CoachError';

  constructor(
    readonly code: CoachErrorCode,
    readonly latestRevision?: number,
  ) {
    super(code);
  }
}

export function isCoachError(value: unknown): value is CoachError {
  return value instanceof CoachError;
}
