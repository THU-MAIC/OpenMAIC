import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { isPBLRoleSession } from '@/lib/pbl/v3/session-kind';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

/** Return a sparse status map for all sessions visible to this owner. */
export async function GET(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const store = await getAgentSessionStore();
    const sessions = await store.listSessionsByOwner(ownerId);
    const statuses = Object.fromEntries(
      sessions
        .filter((session) => !isPBLRoleSession(session.id))
        .map((session) => [session.id, session.status]),
    );
    return NextResponse.json(statuses, { headers: responseHeaders });
  });
}
