/**
 * What the material library's organizing routes share: the gate, reading a
 * JSON body, and their answers. The routes are thin: they resolve the
 * request's owner and call the shared operations in
 * `lib/persistence/material-library.ts` with the request fence, so a retired
 * owner is refused (403) and a busy one asked to retry (503).
 *
 * A refusal the page can act on is `{ success: false, errorCode, error,
 * reason }`, `reason` being the operation's own status (`name_taken`,
 * `not_empty`, ...). A folder or material that is missing or another owner's
 * answers the plain 404 every agent-runtime route uses, so the answer says
 * nothing about another owner's ids.
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  isLockContention,
  OwnerBusyError,
  ownerWriteErrorResponse,
} from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { ApiErrorCode } from '@/lib/server/api-response';
import { ownerNotFound, withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';

/** The JSON object a request carried, or `null` when it is not one. */
export async function jsonObjectBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The repo's error envelope, plus `reason` and any ids the page needs to point at. */
export function libraryRefusal(
  status: number,
  reason: string,
  message: string,
  headers: Headers,
  extra: Record<string, unknown> = {},
  code: ApiErrorCode = 'INVALID_REQUEST',
): NextResponse {
  return withOwnerResponseHeaders(
    NextResponse.json(
      { success: false as const, errorCode: code, error: message, reason, ...extra },
      { status },
    ),
    headers,
  );
}

export function libraryNotFound(headers: Headers): NextResponse {
  return ownerNotFound(headers);
}

export async function libraryPersistence() {
  return getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
}

/** A retired or busy owner's write, answered as every owner write is; otherwise rethrown. */
export function libraryWriteError(error: unknown, headers: Headers): Response {
  const answered = ownerWriteErrorResponse(
    isLockContention(error) ? new OwnerBusyError(error) : error,
    headers,
  );
  if (answered) return answered;
  throw error;
}
