import 'server-only';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import type { AgentRole } from '@/lib/pbl/v3/domain/project/project-schema';
import { SandboxError, sandboxInvalid } from '@/lib/sandbox/errors';
import { LearningStore } from './store';
import { readConversationPage } from './conversation-history';
import { projectConversation } from './conversation';

/** Passive, owner-scoped history reads never allocate or renew an environment. */
export async function conversationPage(principal: OwnerPrincipal, params: URLSearchParams) {
  const id = params.get('id'),
    sessionId = params.get('sessionId');
  const integer = (key: string, optional = false) => {
    const value = params.get(key);
    if (optional && value === null) return null;
    if (
      !value ||
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) <= 0
    )
      throw sandboxInvalid('A valid history cursor is required.');
    return Number(value);
  };
  const through = integer('through')!,
    before = integer('before', true);
  if (!id || !sessionId) throw sandboxInvalid('A learning session and conversation are required.');
  const store = await LearningStore.open();
  await store.get(id, principal.ownerId);
  const binding = (
    await store.pool.query<{ role: AgentRole; last: number }>(
      `SELECT r.role,COALESCE((SELECT max(seq) FROM agent_session_events WHERE session_id=a.id),0) AS last
     FROM pbl_v3_roles r JOIN agent_sessions a ON a.id=r.session_id
     WHERE r.study_id=$1 AND r.session_id=$2 AND a.owner_id=$3 AND a.deleted_at IS NULL`,
      [id, sessionId, principal.ownerId],
    )
  ).rows[0];
  if (!binding) throw new SandboxError('PBL_NOT_FOUND', 404, 'Conversation is unavailable.');
  const ceiling = Math.min(through, Number(binding.last));
  const page = await readConversationPage(store.pool, sessionId, ceiling, before);
  return {
    through: ceiling,
    nextBefore: page.nextBefore,
    conversation: projectConversation(page.events, binding.role, false, undefined, true),
  };
}
