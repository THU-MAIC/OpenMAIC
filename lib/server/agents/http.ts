/**
 * What the agents routes (`app/api/agents/**`) share: the request body
 * checks and the answers for the store's refusals.
 */
import { NextResponse } from 'next/server';

import { isBuiltInAgentId } from '@/lib/orchestration/registry/built-in';
import {
  customAgentFieldsSchema,
  customAgentIdSchema,
  customAgentSchema,
  describeAgentIssue,
  MAX_AGENT_JSON_BYTES,
  type CustomAgent,
} from '@/lib/orchestration/registry/schema';
import { ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { capBodyStream } from '@/lib/server/capped-stream';

import { OwnerAgentExistsError, OwnerAgentLimitError, OwnerAgentNotFoundError } from './store';

export function agentsJsonError(
  status: number,
  code: string,
  message: string,
  headers?: Headers,
): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

export function builtInReadOnlyResponse(headers?: Headers): NextResponse {
  return agentsJsonError(
    403,
    'BUILT_IN_AGENT_READ_ONLY',
    'built-in agents cannot be changed or deleted',
    headers,
  );
}

export async function agentsPool() {
  return (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).pool;
}

/** The largest create or update body: `{ agent }` with the largest schema-valid agent. */
export const MAX_AGENT_BODY_BYTES = MAX_AGENT_JSON_BYTES + 1024;

export type JsonBody = { ok: true; value: unknown } | { ok: false; tooLarge: boolean };

/**
 * The request body as JSON, read through a byte cap (a missing or false
 * `Content-Length` does not get past it).
 */
export async function readCappedJson(req: Request, capBytes: number): Promise<JsonBody> {
  if (!req.body) return { ok: false, tooLarge: false };
  const capped = capBodyStream(req.body, capBytes);
  try {
    return { ok: true, value: JSON.parse(await new Response(capped.stream).text()) };
  } catch {
    return { ok: false, tooLarge: capped.exceeded() };
  }
}

export function bodyTooLargeResponse(capBytes: number, headers?: Headers): NextResponse {
  return agentsJsonError(
    413,
    'BODY_TOO_LARGE',
    `the request body is larger than ${capBytes} bytes`,
    headers,
  );
}

type Parsed = { ok: true; agent: CustomAgent } | { ok: false; response: NextResponse };

/**
 * The `{ agent }` body of a create (with its id) or an update (`id` from the
 * path; a body id, when sent, must be the same).
 */
export async function parseAgentBody(
  req: Request,
  headers: Headers,
  pathId?: string,
): Promise<Parsed> {
  const read = await readCappedJson(req, MAX_AGENT_BODY_BYTES);
  if (!read.ok && read.tooLarge) {
    return { ok: false, response: bodyTooLargeResponse(MAX_AGENT_BODY_BYTES, headers) };
  }
  const body = (read.ok ? read.value : undefined) as { agent?: unknown } | undefined;
  const raw = body && typeof body === 'object' ? body.agent : undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      response: agentsJsonError(400, 'INVALID_REQUEST', 'expected { agent }', headers),
    };
  }
  const { id: bodyId, ...fields } = raw as Record<string, unknown>;
  const id = pathId ?? bodyId;
  if (typeof id === 'string' && isBuiltInAgentId(id)) {
    return { ok: false, response: builtInReadOnlyResponse(headers) };
  }
  if (pathId !== undefined && bodyId !== undefined && bodyId !== pathId) {
    return {
      ok: false,
      response: agentsJsonError(400, 'INVALID_AGENT', 'id: does not match the path', headers),
    };
  }
  const parsed =
    pathId === undefined
      ? customAgentSchema.safeParse(raw)
      : customAgentFieldsSchema.safeParse(fields);
  if (!parsed.success) {
    return {
      ok: false,
      response: agentsJsonError(400, 'INVALID_AGENT', describeAgentIssue(parsed.error), headers),
    };
  }
  if (pathId === undefined) return { ok: true, agent: parsed.data as CustomAgent };
  const idCheck = customAgentIdSchema.safeParse(pathId);
  if (!idCheck.success) {
    return {
      ok: false,
      response: agentsJsonError(404, 'AGENT_NOT_FOUND', 'no such agent', headers),
    };
  }
  return { ok: true, agent: { ...parsed.data, id: pathId } };
}

/** The answer for a store refusal, or undefined for any other error. */
export function agentWriteErrorResponse(error: unknown, headers: Headers): Response | undefined {
  if (error instanceof OwnerAgentExistsError) {
    return agentsJsonError(409, 'AGENT_EXISTS', error.message, headers);
  }
  if (error instanceof OwnerAgentNotFoundError) {
    return agentsJsonError(404, 'AGENT_NOT_FOUND', 'no such agent', headers);
  }
  if (error instanceof OwnerAgentLimitError) {
    return agentsJsonError(409, 'AGENT_LIMIT_REACHED', error.message, headers);
  }
  return ownerWriteErrorResponse(error, headers);
}
