import { NextResponse } from 'next/server';

import { apiError, type ApiErrorCode } from '@/lib/server/api-response';

/**
 * Response builders for owner-scoped routes.
 *
 * Every response of an owner-scoped route must carry the response headers the
 * owner resolution produced: a freshly minted anonymous cookie must ride
 * success AND 4xx/5xx responses alike, so a client that retries after an error
 * keeps the same owner partition (see `with-owner.ts`).
 */

/** Attach the owner-resolution headers (e.g. a minted Set-Cookie) to a response. */
export function withOwnerResponseHeaders(response: NextResponse, headers: Headers): NextResponse {
  for (const [key, value] of headers) response.headers.append(key, value);
  return response;
}

/** A JSON body under the owner headers. */
export function ownerJson(body: unknown, status: number, headers: Headers): NextResponse {
  return NextResponse.json(body, { status, headers });
}

/** The repo's apiError envelope under the owner headers. */
export function ownerApiError(
  code: ApiErrorCode,
  status: number,
  message: string,
  headers: Headers,
  details?: string,
): NextResponse {
  return withOwnerResponseHeaders(apiError(code, status, message, details), headers);
}

/**
 * The no-existence-oracle 404: foreign and missing resources answer the same
 * plain body as every other agent-runtime route (an existence probe must not
 * be able to distinguish "never existed" from "someone else's").
 */
export function ownerNotFound(headers: Headers): NextResponse {
  return new NextResponse('Not found', { status: 404, headers });
}
