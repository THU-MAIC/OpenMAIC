/**
 * How the importer reads a failure: retry it later, give up on this item, or
 * stop the whole run.
 *
 * The persistence clients carry the server's answer as `status` + `code` on
 * their error classes (documents, runtime, assets); a write-back failure wraps
 * the store's error in `cause`. Anything without a status -- a dropped
 * connection, a fetch that never reached the server -- is transient.
 */
export type FailureKind =
  /** Network, 5xx, 408/429, 409: leave the item pending and retry on a later load. */
  | 'transient'
  /** 503 OWNER_BUSY: the owner is being claimed; wait `retryAfterMs` and retry. */
  | 'busy'
  /** 401 INVALID_CREDENTIAL / 403 OWNER_RETIRED: nothing this owner writes will land. */
  | 'owner'
  /** The asset store has no room for these bytes. */
  | 'quota'
  /** 403 on a document this owner does not own. */
  | 'forbidden'
  /** 404 on a write: the target is gone (for a course: deleted on the server). */
  | 'not-found'
  /** 400 / 413 / 422 and the like: the server refuses this item as it is. */
  | 'permanent';

export interface Failure {
  readonly kind: FailureKind;
  readonly reason: string;
  readonly retryAfterMs?: number;
}

/** The server's documented pause for OWNER_BUSY (`Retry-After: 2`). */
export const DEFAULT_BUSY_RETRY_MS = 2_000;

interface StatusLike {
  status?: unknown;
  code?: unknown;
  retryAfterMs?: unknown;
  cause?: unknown;
}

function statusOf(error: unknown): { status?: number; code?: string; retryAfterMs?: number } {
  // Walk the `cause` chain: MediaReferenceWriteBackError and friends wrap the
  // store error that carries the status.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as StatusLike;
    if (typeof candidate.status === 'number') {
      return {
        status: candidate.status,
        ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
        ...(typeof candidate.retryAfterMs === 'number'
          ? { retryAfterMs: candidate.retryAfterMs }
          : {}),
      };
    }
    if (typeof candidate.code === 'string' && candidate.code === 'ASSET_QUOTA_EXCEEDED') {
      return { status: 507, code: candidate.code };
    }
    current = candidate.cause;
  }
  return {};
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

export function classifyFailure(error: unknown): Failure {
  const { status, code, retryAfterMs } = statusOf(error);
  if (status === undefined) return { kind: 'transient', reason: describe(error) };
  const reason = code ? `${status} ${code}` : `HTTP ${status}`;
  if (code === 'OWNER_BUSY') {
    return { kind: 'busy', reason, retryAfterMs: retryAfterMs ?? DEFAULT_BUSY_RETRY_MS };
  }
  if (code === 'OWNER_RETIRED' || code === 'INVALID_CREDENTIAL' || status === 401) {
    return { kind: 'owner', reason };
  }
  if (status === 507 || code === 'ASSET_QUOTA_EXCEEDED') {
    return { kind: 'quota', reason };
  }
  if (status >= 500 || status === 408 || status === 409 || status === 425 || status === 429) {
    return { kind: 'transient', reason };
  }
  if (status === 403) return { kind: 'forbidden', reason };
  if (status === 404) return { kind: 'not-found', reason };
  return { kind: 'permanent', reason };
}

/**
 * Thrown to end a run early: the owner refused every write, or asked to be
 * left alone for a while. Carries the failure that ended it.
 */
export class ImportRunStop extends Error {
  override readonly name = 'ImportRunStop';

  constructor(readonly failure: Failure) {
    super(failure.reason);
  }
}

/** Rethrow owner-level failures as a run stop; hand every other failure back. */
export function failureOrStop(error: unknown): Failure {
  if (error instanceof ImportRunStop) throw error;
  const failure = classifyFailure(error);
  if (failure.kind === 'owner' || failure.kind === 'busy') throw new ImportRunStop(failure);
  return failure;
}
