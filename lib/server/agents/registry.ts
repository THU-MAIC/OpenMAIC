/**
 * The agents an owner can use, on the server: the built-in agents from code
 * and the owner's custom agents from the database (`./store.ts`). Runs and
 * the UI name agents by id; this is where an id becomes an agent.
 */
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { BUILT_IN_AGENTS } from '@/lib/orchestration/registry/built-in';
import type { CustomAgent } from '@/lib/orchestration/registry/schema';
import { canonicalizeOwner } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

import { listOwnerAgents, readOwnerAgents, type StoredCustomAgent } from './store';

/** Agent ids that name neither a built-in agent nor one of the owner's. */
export class UnknownAgentsError extends Error {
  readonly code = 'UNKNOWN_AGENTS';
  constructor(readonly agentIds: readonly string[]) {
    super(`unknown agent ids: ${agentIds.join(', ')}`);
    this.name = 'UnknownAgentsError';
  }
}

export function isUnknownAgentsError(error: unknown): error is UnknownAgentsError {
  return error instanceof UnknownAgentsError;
}

/** A stored custom agent as the rest of the app sees agents. */
export function customAgentConfig(stored: StoredCustomAgent): AgentConfig {
  // The registry type narrows a voice's provider to this app's; the stored
  // value is an open string, and the TTS path treats an unknown one as unbound.
  const agent = stored.agent as Omit<CustomAgent, 'voiceConfig'> & Pick<AgentConfig, 'voiceConfig'>;
  return { ...agent, createdAt: stored.createdAt, updatedAt: stored.updatedAt, isDefault: false };
}

async function pool() {
  return (await getServerPersistenceProvider(process.env.DATABASE_URL ?? '')).pool;
}

/**
 * Every agent `ownerId` can use: the built-in agents, then the owner's custom
 * agents, oldest first. An owner a claim retired reads the account's.
 */
export async function listAgentsForOwner(ownerId: string): Promise<AgentConfig[]> {
  const queryable = await pool();
  const owner = await canonicalizeOwner(queryable, ownerId);
  const custom = await listOwnerAgents(queryable, owner);
  return [...Object.values(BUILT_IN_AGENTS), ...custom.map((stored) => customAgentConfig(stored))];
}

/**
 * The agents `agentIds` name, in that order: a built-in id from code, any
 * other from the owner's custom agents. Throws {@link UnknownAgentsError}
 * listing every id that names neither. Only built-in ids never touch the
 * database.
 */
export async function resolveAgentsForOwner(
  ownerId: string,
  agentIds: string[],
): Promise<AgentConfig[]> {
  const customIds = [...new Set(agentIds.filter((id) => !Object.hasOwn(BUILT_IN_AGENTS, id)))];
  const custom = new Map<string, AgentConfig>();
  if (customIds.length > 0) {
    const queryable = await pool();
    const owner = await canonicalizeOwner(queryable, ownerId);
    for (const stored of await readOwnerAgents(queryable, owner, customIds)) {
      custom.set(stored.agent.id, customAgentConfig(stored));
    }
  }
  const unknown = customIds.filter((id) => !custom.has(id));
  if (unknown.length > 0) throw new UnknownAgentsError(unknown);
  return agentIds.map((id) => BUILT_IN_AGENTS[id] ?? custom.get(id)!);
}
