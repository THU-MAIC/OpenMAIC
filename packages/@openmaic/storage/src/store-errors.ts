/**
 * Errors a store raises as policy rather than as faults, recognized by every
 * HTTP handler in this package (runtime, documents, assets):
 *
 * - {@link DocumentWriteRefusedError} (defined with the document contract,
 *   where it started): the write is refused and applies nothing. Answered
 *   `403` with the error's code by every handler, not only the document one.
 * - {@link StorageBusyError}: the write could not run now and may be retried
 *   as it is. Answered `503` with the error's code and a `Retry-After`.
 *
 * Both are recognized across copies of the package (a host store bundled
 * separately) by name and shape, as `isDocumentWriteRefusedError` already is.
 */
import { isDocumentWriteRefusedError } from './document/types.js';

const BUSY_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A write that could not run now (lock contention, a concurrent operation) and may be retried. */
export class StorageBusyError extends Error {
  override readonly name = 'StorageBusyError';

  constructor(
    readonly code: string,
    message: string,
    /** Seconds a client should wait before retrying; a positive integer. */
    readonly retryAfterSeconds = 1,
    options?: { cause?: unknown },
  ) {
    if (!BUSY_CODE.test(code)) {
      throw new TypeError(
        `@openmaic/storage: busy code must match ${String(BUSY_CODE)}, got ${JSON.stringify(code)}`,
      );
    }
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
      throw new TypeError('@openmaic/storage: retryAfterSeconds must be a positive integer');
    }
    super(message, options);
  }
}

/** Whether `error` is a {@link StorageBusyError}, from this copy of the package or another. */
export function isStorageBusyError(error: unknown): error is StorageBusyError {
  if (error instanceof StorageBusyError) return true;
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; retryAfterSeconds?: unknown };
  return (
    candidate.name === 'StorageBusyError' &&
    typeof candidate.code === 'string' &&
    BUSY_CODE.test(candidate.code) &&
    typeof candidate.retryAfterSeconds === 'number' &&
    Number.isSafeInteger(candidate.retryAfterSeconds) &&
    candidate.retryAfterSeconds >= 1
  );
}

/** How a handler answers a policy error, or `undefined` for anything else. */
export function storePolicyResponse(
  error: unknown,
): { status: number; code: string; message: string; headers: Record<string, string> } | undefined {
  if (isDocumentWriteRefusedError(error)) {
    return { status: 403, code: error.code, message: error.message, headers: {} };
  }
  if (isStorageBusyError(error)) {
    return {
      status: 503,
      code: error.code,
      message: error.message,
      headers: { 'retry-after': String(error.retryAfterSeconds) },
    };
  }
  return undefined;
}
