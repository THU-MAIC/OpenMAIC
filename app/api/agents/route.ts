/**
 * GET/POST /api/agents — the agents the request's owner can use (RFC #1754,
 * G).
 *
 * GET answers `{ agents }`: the built-in agents (from code, `readOnly: true`)
 * and then the owner's custom agents. POST `{ agent }` creates a custom agent
 * under the id it carries (`customAgentSchema`); an id the owner already uses
 * answers 409 `AGENT_EXISTS`, a built-in id 403 `BUILT_IN_AGENT_READ_ONLY`.
 * The owner is the request's, through the owner identity seam.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { agentView } from '@/lib/orchestration/registry/wire';
import { agentsPool, agentWriteErrorResponse, parseAgentBody } from '@/lib/server/agents/http';
import { customAgentConfig, listAgentsForOwner } from '@/lib/server/agents/registry';
import { createOwnerAgent } from '@/lib/server/agents/store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const agents = await listAgentsForOwner(ownerId);
    return NextResponse.json({ agents: agents.map(agentView) }, { headers });
  });
}

export async function POST(req: NextRequest) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const parsed = await parseAgentBody(req, headers);
    if (!parsed.ok) return parsed.response;
    try {
      const stored = await createOwnerAgent(await agentsPool(), ownerId, parsed.agent);
      return NextResponse.json(
        { agent: agentView(customAgentConfig(stored)) },
        { status: 201, headers },
      );
    } catch (error) {
      const refused = agentWriteErrorResponse(error, headers);
      if (refused) return refused;
      throw error;
    }
  });
}
