/**
 * PUT/DELETE /api/agents/[id] — change or delete one of the request owner's
 * custom agents (RFC #1754, G).
 *
 * PUT `{ agent }` replaces the agent's fields (`customAgentSchema` without
 * the id, which is the path's). A built-in agent is read-only: both answer
 * 403 `BUILT_IN_AGENT_READ_ONLY`. An id the owner does not use answers 404
 * `AGENT_NOT_FOUND`, the same for every other owner's agents.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { isBuiltInAgentId } from '@/lib/orchestration/registry/built-in';
import { agentView } from '@/lib/orchestration/registry/wire';
import {
  agentsJsonError,
  agentsPool,
  agentWriteErrorResponse,
  builtInReadOnlyResponse,
  parseAgentBody,
} from '@/lib/server/agents/http';
import { customAgentConfig } from '@/lib/server/agents/registry';
import { deleteOwnerAgent, updateOwnerAgent } from '@/lib/server/agents/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const { id } = await params;
    const parsed = await parseAgentBody(req, headers, id);
    if (!parsed.ok) return parsed.response;
    try {
      const stored = await updateOwnerAgent(await agentsPool(), ownerId, parsed.agent);
      return NextResponse.json({ agent: agentView(customAgentConfig(stored)) }, { headers });
    } catch (error) {
      const refused = agentWriteErrorResponse(error, headers);
      if (refused) return refused;
      throw error;
    }
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const { id } = await params;
    if (isBuiltInAgentId(id)) return builtInReadOnlyResponse(headers);
    try {
      if (!(await deleteOwnerAgent(await agentsPool(), ownerId, id))) {
        return agentsJsonError(404, 'AGENT_NOT_FOUND', 'no such agent', headers);
      }
      return new Response(null, { status: 204, headers });
    } catch (error) {
      const refused = agentWriteErrorResponse(error, headers);
      if (refused) return refused;
      throw error;
    }
  });
}
