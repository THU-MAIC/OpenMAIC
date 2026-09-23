'use server';

import { requireContextOwner } from '@/lib/server/identity/resolve';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';

/**
 * Server Action mutation used by the workspace row menu.
 *
 * The owner comes from the same authenticator the routes use, through its
 * Server Action entry point (a Server Action has no `Request`): with the
 * built-ins, the deployment-wide shared owner when one is configured,
 * otherwise the anonymous cookie, minted here when absent. So the workspace
 * list the routes filter and the row actions taken here always agree on one
 * owner.
 */
export async function deleteWorkspaceSession(id: string): Promise<{ deleted: boolean }> {
  const sessionId = id.trim();
  if (!sessionId) return { deleted: false };
  const { ownerId } = await requireContextOwner();
  const store = await getAgentSessionStore();
  return { deleted: await store.softDeleteSession(sessionId, ownerId) };
}
