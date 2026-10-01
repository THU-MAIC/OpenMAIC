/**
 * Agent Registry Store
 *
 * The agents this page knows, in memory: the built-in agents (code,
 * read-only), the owner's custom agents (read from and written to the server,
 * `/api/agents`), and the generated agents of the course on screen (mirrored
 * from its stage document by `applyGeneratedAgentsToRegistry`, never stored
 * here). Nothing is kept in browser storage: the custom agents an earlier build
 * kept in localStorage are imported to the server in the background after the
 * first read (`lib/legacy-browser-import/agents-import.ts`).
 *
 * Every request to the server (each change, each read of the list) runs in
 * one queue, in the order it was made, and the registry applies only what the
 * server answered: a refusal leaves nothing to undo, a later answer is always
 * the newer state, and a read that began before a delete is applied before it.
 *
 * `agents` is a null-prototype object, so an id like `constructor` never finds
 * an inherited property.
 *
 * Server-importable: the server-side chat paths read the built-in agents from
 * it, and nothing here reaches the network until a client calls the load or
 * changes a custom agent.
 */

import { create } from 'zustand';
import type { AgentConfig } from './types';
import { getActionsForRole } from './types';
import { BUILT_IN_AGENTS, getBuiltInAgent, isBuiltInAgentId } from './built-in';
import {
  createCustomAgent,
  deleteCustomAgent,
  fetchCustomAgents,
  updateCustomAgent,
} from './client';
import { customAgentFields, customAgentFieldsSchema, customAgentSchema } from './schema';
import { isKnownTTSProviderId } from '@/lib/audio/constants';
import type { PendingLegacyAgent } from '@/lib/legacy-browser-import/agents-import';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import { USER_AVATAR } from '@/lib/types/roundtable';
import type { Participant, ParticipantRole } from '@/lib/types/roundtable';
import { useUserProfileStore } from '@/lib/store/user-profile';

export { getDefaultAgents } from './built-in';

interface AgentRegistryState {
  agents: Record<string, AgentConfig>; // Map of agentId -> config (null prototype)
  /** Whether the owner's custom agents have been read from the server on this page. */
  customAgentsLoaded: boolean;
  /**
   * Custom agents an earlier build kept in this browser that are not on the
   * server yet (the owner's limit, a record the server refuses). They stay in
   * the browser and the import tries them again on a later load.
   */
  legacyAgentsPending: readonly PendingLegacyAgent[];

  // Actions. A generated agent changes in memory only, at once. A custom agent
  // changes once the server saved it; the promise settles with that save (and
  // rejects on a refusal, leaving the registry as it was). Built-in agents are
  // read-only: changing or deleting one rejects.
  addAgent: (agent: AgentConfig) => Promise<void>;
  updateAgent: (id: string, updates: Partial<AgentConfig>) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  getAgent: (id: string) => AgentConfig | undefined;
  listAgents: () => AgentConfig[];
}

/** A null-prototype agent map holding `agents`. */
function agentMap(agents: Iterable<AgentConfig> = []): Record<string, AgentConfig> {
  const map = Object.create(null) as Record<string, AgentConfig>;
  for (const agent of agents) map[agent.id] = agent;
  return map;
}

function own(agents: Record<string, AgentConfig>, id: string): AgentConfig | undefined {
  return Object.hasOwn(agents, id) ? agents[id] : undefined;
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

let serverQueue: Promise<unknown> = Promise.resolve();

/** Run `operation` after every server request made before it. */
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = serverQueue.then(operation, operation);
  serverQueue = run.catch(() => undefined);
  return run;
}

export const useAgentRegistry = create<AgentRegistryState>()((set, get) => {
  const put = (agent: AgentConfig) =>
    set((state) => ({ agents: agentMap([...Object.values(state.agents), agent]) }));
  /** Remove `id`, or put `replacement` in its place. */
  const drop = (id: string, replacement?: AgentConfig) =>
    set((state) => {
      const kept = Object.values(state.agents).filter((agent) => agent.id !== id);
      return { agents: agentMap(replacement ? [...kept, replacement] : kept) };
    });

  return {
    // Built-in agents are always there, on the server too.
    agents: agentMap(Object.values(BUILT_IN_AGENTS)),
    customAgentsLoaded: false,
    legacyAgentsPending: [],

    addAgent: async (agent) => {
      if (agent.isGenerated) {
        put(agent);
        return;
      }
      if (isBuiltInAgentId(agent.id)) throw readOnlyError(agent.id);
      const custom = customAgentSchema.parse(customAgentFields(agent));
      await enqueue(async () => put(usableCustomAgent(await createCustomAgent(custom))));
    },

    updateAgent: async (id, updates) => {
      const current = own(get().agents, id);
      if (current?.isGenerated) {
        put({ ...current, ...updates, id, updatedAt: new Date() });
        return;
      }
      if (current?.isDefault || isBuiltInAgentId(id)) throw readOnlyError(id);
      await enqueue(async () => {
        // Merged with the agent as the requests before this one left it.
        const latest = own(get().agents, id);
        if (!latest) throw new Error(`Unknown agent ${id}`);
        const { id: _id, ...fields } = customAgentFields({ ...latest, ...updates, id });
        const parsed = customAgentFieldsSchema.parse(fields);
        put(usableCustomAgent(await updateCustomAgent(id, parsed)));
      });
    },

    deleteAgent: async (id) => {
      const current = own(get().agents, id);
      if (current?.isGenerated) {
        // A generated agent may have shadowed a built-in one of the same id.
        drop(id, getBuiltInAgent(id));
        return;
      }
      if (current?.isDefault || isBuiltInAgentId(id)) throw readOnlyError(id);
      await enqueue(async () => {
        await deleteCustomAgent(id);
        drop(id);
      });
    },

    getAgent: (id) => own(get().agents, id),

    listAgents: () => Object.values(get().agents),
  };
});

/**
 * Read the owner's custom agents from the server into the registry, in the
 * request queue. Built-in and generated agents stay as they are. Rejects when
 * the agents could not be read; the registry then keeps what it had.
 */
export function loadAgentRegistry(): Promise<void> {
  return enqueue(async () => {
    const custom = (await fetchCustomAgents()).map(usableCustomAgent);
    useAgentRegistry.setState((state) => {
      const generated = Object.values(state.agents).filter((agent) => agent.isGenerated);
      const agents = agentMap([...Object.values(BUILT_IN_AGENTS), ...custom, ...generated]);
      return { agents, customAgentsLoaded: true };
    });
  });
}

let legacyImport: Promise<void> | undefined;

/**
 * Import the custom agents an earlier build kept in this browser (once they
 * are all on the server, never again), and read the list again when that
 * added any. Both run in the request queue, one after the other, so a change
 * made while the import runs is applied after it and before the new read.
 * Never rejects. Loaded on demand: it is temporary.
 */
export function importLegacyAgents(): Promise<void> {
  legacyImport ??= (async () => {
    try {
      const { runAgentsImport } = await import('@/lib/legacy-browser-import/agents-import');
      const result = await enqueue(() => runAgentsImport());
      useAgentRegistry.setState({ legacyAgentsPending: result.pending });
      if (result.imported > 0) await loadAgentRegistry();
    } catch (error) {
      console.warn('[legacy-browser-import] Agents import failed:', error);
    } finally {
      legacyImport = undefined;
    }
  })();
  return legacyImport;
}

let firstLoad: Promise<boolean> | undefined;

/** Read the list; on success, start the legacy import in the background. */
function startLoad(): Promise<boolean> {
  const load: Promise<boolean> = loadAgentRegistry().then(
    () => {
      void importLegacyAgents();
      return true;
    },
    (error: unknown) => {
      console.warn('[agent-registry] Could not read the custom agents:', error);
      // Not remembered: the next caller reads again.
      if (firstLoad === load) firstLoad = undefined;
      return false;
    },
  );
  firstLoad = load;
  return load;
}

/** How long code that resolves agent ids waits for the custom agents. */
export const AGENT_REGISTRY_WAIT_MS = 5_000;

/**
 * Whether the owner's custom agents are in the registry, waiting for the
 * page's read (started on the first call, shared while it runs, and read again
 * after a failure) at most `timeoutMs`. Never rejects. Code that resolves ids
 * the user picked (a classroom's selection, a generation's preset agents)
 * waits for it, and on `false` must not treat an unknown id as a deleted
 * agent: it may be a custom agent the registry could not read yet.
 */
export function whenAgentRegistryLoaded(timeoutMs = AGENT_REGISTRY_WAIT_MS): Promise<boolean> {
  if (useAgentRegistry.getState().customAgentsLoaded) return Promise.resolve(true);
  const load = firstLoad ?? startLoad();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void load.then((loaded) => {
      clearTimeout(timer);
      resolve(loaded);
    });
  });
}

/**
 * Read the custom agents again now (and retry the legacy import): after the
 * access code was accepted, when the first read was refused.
 */
export function reloadAgentRegistry(): Promise<boolean> {
  return startLoad();
}

/** Test hook: forget the page's loads and imports. */
export function resetAgentRegistryLoadForTests(): void {
  firstLoad = undefined;
  legacyImport = undefined;
  serverQueue = Promise.resolve();
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
