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
  type CustomAgent,
} from '@/lib/orchestration/registry/schema';
import { ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

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

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
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
  const body = (await readJson(req)) as { agent?: unknown } | undefined;
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
