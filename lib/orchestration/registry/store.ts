/**
 * Agent Registry Store
 *
 * The agents this page knows, in memory: the built-in agents (code,
 * read-only), the owner's custom agents (read from and written to the server,
 * `/api/agents`), and the generated agents of the course on screen (mirrored
 * from its stage document by `applyGeneratedAgentsToRegistry`, never stored
 * here). Nothing is kept in browser storage: the custom agents an earlier build
 * kept in localStorage are imported to the server once
 * (`lib/legacy-browser-import/agents-import.ts`) before the first load.
 *
 * Server-importable: the server-side chat paths read the built-in agents from
 * it, and nothing here reaches the network until a client calls the load or
 * changes a custom agent.
 */

import { create } from 'zustand';
import type { AgentConfig } from './types';
import { getActionsForRole } from './types';
import { BUILT_IN_AGENTS, isBuiltInAgentId } from './built-in';
import {
  createCustomAgent,
  deleteCustomAgent,
  fetchCustomAgents,
  updateCustomAgent,
} from './client';
import { customAgentFields, customAgentFieldsSchema, customAgentSchema } from './schema';
import { isKnownTTSProviderId } from '@/lib/audio/constants';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import { USER_AVATAR } from '@/lib/types/roundtable';
import type { Participant, ParticipantRole } from '@/lib/types/roundtable';
import { useUserProfileStore } from '@/lib/store/user-profile';

export { getDefaultAgents } from './built-in';

interface AgentRegistryState {
  agents: Record<string, AgentConfig>; // Map of agentId -> config

  // Actions. A generated agent changes in memory only; a custom agent is
  // saved on the server, and the promise settles with that save (on a refusal
  // the agent is restored and the promise rejects). Built-in agents are
  // read-only: changing or deleting one rejects.
  addAgent: (agent: AgentConfig) => Promise<void>;
  updateAgent: (id: string, updates: Partial<AgentConfig>) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  getAgent: (id: string) => AgentConfig | undefined;
  listAgents: () => AgentConfig[];
}

function readOnlyError(id: string): Error {
  return new Error(`Agent ${id} is built in and cannot be changed`);
}

/** A custom agent as the server answered it, with a voice this app can use. */
function usableCustomAgent(agent: AgentConfig): AgentConfig {
  if (!agent.voiceConfig || isKnownTTSProviderId(agent.voiceConfig.providerId)) return agent;
  const { voiceConfig: _unknownProvider, ...rest } = agent;
  return rest;
}

export const useAgentRegistry = create<AgentRegistryState>()((set, get) => {
  /** Put `agent` back (or remove `id` when it was absent): a refused save. */
  const restore = (id: string, previous: AgentConfig | undefined) =>
    set((state) => {
      const { [id]: _current, ...rest } = state.agents;
      return { agents: previous ? { ...rest, [id]: previous } : rest };
    });
  const put = (agent: AgentConfig) =>
    set((state) => ({ agents: { ...state.agents, [agent.id]: agent } }));

  return {
    // Built-in agents are always there, on the server too.
    agents: { ...BUILT_IN_AGENTS },

    addAgent: async (agent) => {
      if (agent.isGenerated) {
        put(agent);
        return;
      }
      if (isBuiltInAgentId(agent.id)) throw readOnlyError(agent.id);
      const custom = customAgentSchema.parse(customAgentFields(agent));
      const previous = get().agents[agent.id];
      put({ ...agent, isDefault: false });
      try {
        put(usableCustomAgent(await createCustomAgent(custom)));
      } catch (error) {
        restore(agent.id, previous);
        throw error;
      }
    },

    updateAgent: async (id, updates) => {
      const current = get().agents[id];
      if (!current) throw new Error(`Unknown agent ${id}`);
      const next: AgentConfig = { ...current, ...updates, id, updatedAt: new Date() };
      if (current.isGenerated) {
        put(next);
        return;
      }
      if (current.isDefault || isBuiltInAgentId(id)) throw readOnlyError(id);
      const { id: _id, ...fields } = customAgentFields(next);
      const parsed = customAgentFieldsSchema.parse(fields);
      put(next);
      try {
        put(usableCustomAgent(await updateCustomAgent(id, parsed)));
      } catch (error) {
        restore(id, current);
        throw error;
      }
    },

    deleteAgent: async (id) => {
      const current = get().agents[id];
      if (!current) return;
      if (current.isGenerated) {
        // A generated agent may have shadowed a built-in one of the same id.
        restore(id, BUILT_IN_AGENTS[id]);
        return;
      }
      if (current.isDefault || isBuiltInAgentId(id)) throw readOnlyError(id);
      restore(id, undefined);
      try {
        await deleteCustomAgent(id);
      } catch (error) {
        restore(id, current);
        throw error;
      }
    },

    getAgent: (id) => get().agents[id],

    listAgents: () => Object.values(get().agents),
  };
});

/**
 * Read the owner's custom agents from the server into the registry, after
 * importing the ones an earlier build kept in this browser (once per
 * browser). Built-in and generated agents stay as they are. Rejects when the
 * agents could not be read; the registry then keeps what it had.
 */
export async function loadAgentRegistry(): Promise<void> {
  // The import never throws (it logs and retries on a later load), and is
  // loaded on demand: it is temporary, and only this first read needs it.
  await import('@/lib/legacy-browser-import/agents-import')
    .then(({ runAgentsImport }) => runAgentsImport())
    .catch((error: unknown) => console.warn('[legacy-browser-import] Could not load:', error));
  const custom = (await fetchCustomAgents()).map(usableCustomAgent);
  useAgentRegistry.setState((state) => {
    const agents: Record<string, AgentConfig> = { ...BUILT_IN_AGENTS };
    for (const agent of Object.values(state.agents)) {
      if (agent.isGenerated) agents[agent.id] = agent;
    }
    for (const agent of custom) if (!agents[agent.id]) agents[agent.id] = agent;
    return { agents };
  });
}

let firstLoad: Promise<void> | undefined;

/**
 * The page's first {@link loadAgentRegistry}, started on the first call and
 * shared by every caller after it. Never rejects: a failed read is logged and
 * the registry holds the built-in agents. Code that resolves agent ids the
 * user picked (a classroom's selection, a generation's preset agents) awaits
 * it, so a custom agent is not mistaken for a missing one before it arrives.
 */
export function whenAgentRegistryLoaded(): Promise<void> {
  firstLoad ??= loadAgentRegistry().catch((error: unknown) => {
    console.warn('[agent-registry] Could not read the custom agents:', error);
  });
  return firstLoad;
}

/** Test hook: forget the page's first load. */
export function resetAgentRegistryLoadForTests(): void {
  firstLoad = undefined;
}

/**
 * Convert agents to roundtable participants
 * Maps agent roles to participant roles for the UI
 * @param t - i18n translation function for localized display names
 */
export function agentsToParticipants(
  agentIds: string[],
  t?: (key: string) => string,
): Participant[] {
  const registry = useAgentRegistry.getState();
  const participants: Participant[] = [];
  let hasTeacher = false;

  // Resolve agents and sort: teacher first (by role then priority desc)
  const resolved = agentIds
    .map((id) => registry.getAgent(id))
    .filter((a): a is AgentConfig => a != null);
  resolved.sort((a, b) => {
    if (a.role === 'teacher' && b.role !== 'teacher') return -1;
    if (a.role !== 'teacher' && b.role === 'teacher') return 1;
    return (b.priority ?? 0) - (a.priority ?? 0);
  });

  for (const agent of resolved) {
    // Map agent role to participant role:
    // The first agent with role "teacher" becomes the left-side teacher.
    // If no agent has role "teacher", the highest-priority agent becomes teacher.
    let role: ParticipantRole = 'student';
    if (!hasTeacher) {
      role = 'teacher';
      hasTeacher = true;
    }

    // Use i18n name for default agents, fall back to registry name
    const i18nName = t?.(`settings.agentNames.${agent.id}`);
    const displayName =
      i18nName && i18nName !== `settings.agentNames.${agent.id}` ? i18nName : agent.name;

    participants.push({
      id: agent.id,
      name: displayName,
      role,
      avatar: agent.avatar,
      isOnline: true,
      isSpeaking: false,
    });
  }

  // Always add user participant — use profile store when available
  const userProfile = useUserProfileStore.getState();
  const userName = userProfile.nickname || t?.('common.you') || 'You';
  const userAvatar = userProfile.avatar || USER_AVATAR;

  participants.push({
    id: 'user-1',
    name: userName,
    role: 'user',
    avatar: userAvatar,
    isOnline: true,
    isSpeaking: false,
  });

  return participants;
}

/**
 * Replace the registry's generated agents with the given stage roster.
 *
 * In-memory registry side effect: the persisted source of truth for the
 * roster is `stage.generatedAgentConfigs` on the stage document, and callers
 * persist it through the document path; a generated agent changes the
 * registry in memory only, so nothing written here becomes durable.
 * Clears previously loaded generated agents first (even when the new roster is
 * empty) so a prior classroom's roster cannot leak into the current one.
 * The contract keeps `voiceConfig.providerId` an open string; a binding whose
 * provider is not registered in this app is dropped here (the agent keeps its
 * voiceDesign, and the TTS path falls back at call time).
 * Returns the applied agent IDs.
 */
export function applyGeneratedAgentsToRegistry(
  stageId: string,
  agents: ReadonlyArray<GeneratedAgentConfig>,
): string[] {
  const registry = useAgentRegistry.getState();
  for (const agent of registry.listAgents()) {
    if (agent.isGenerated) registry.deleteAgent(agent.id);
  }

  const now = Date.now();
  const ids: string[] = [];
  for (const agent of agents) {
    const { voiceConfig, ...rest } = agent;
    registry.addAgent({
      ...rest,
      allowedActions: getActionsForRole(agent.role),
      isDefault: false,
      isGenerated: true,
      boundStageId: stageId,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      ...(voiceConfig && isKnownTTSProviderId(voiceConfig.providerId)
        ? {
            voiceConfig: {
              providerId: voiceConfig.providerId,
              ...(voiceConfig.modelId ? { modelId: voiceConfig.modelId } : {}),
              voiceId: voiceConfig.voiceId,
            },
          }
        : {}),
    });
    ids.push(agent.id);
  }

  // Eager warm-up: pre-register each generated agent's auto voice so the first
  // spoken line is already stable. Same idempotent ensure as the TTS path;
  // fire-and-forget. Dynamic import keeps this client-only dep out of the
  // server-importable store module.
  if (ids.length > 0 && typeof window !== 'undefined') {
    void import('@/lib/audio/agent-voice')
      .then((m) => m.warmUpAgentVoices(registry.listAgents().filter((a) => a.isGenerated)))
      .catch(() => undefined);
  }

  return ids;
}
