/**
 * Start a classic generation as a server-side run from the run input the
 * composer describes, with the materials it already uploaded (and the server
 * extracted) since they were attached. The server resolves every model and provider; the browser sends
 * the learner's choices only (agents, learner profile, narrator voice).
 */
import { ttsSelection } from '@/lib/audio/tts-selection';
import type { ModelCapabilities } from '@/lib/model-settings/capabilities';
import { useAgentRegistry, whenAgentRegistryLoaded } from '@/lib/orchestration/registry/store';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserProfileStore } from '@/lib/store/user-profile';

import { RunApiError, startGenerationRun, type StartRunInput } from './api';
import type { RunSnapshot } from './types';

/** A start refused before anything was submitted; `reason` is the translation key that says why. */
export class RunStartRefusedError extends Error {
  constructor(
    readonly reason: 'generation.customAgentsUnavailable',
    readonly values: Record<string, string | number> = {},
  ) {
    super(reason);
    this.name = 'RunStartRefusedError';
  }
}

/** The agents the course is taught by, as the learner selected them. */
export async function selectedRunAgents(): Promise<StartRunInput['agents']> {
  // The owner's custom agents come from the server: wait for them (with a
  // bound) before the selection is read, or a custom agent would be dropped
  // as unknown.
  const agentsKnown = await whenAgentRegistryLoaded();
  const settings = useSettingsStore.getState();
  const registry = useAgentRegistry.getState();
  if (
    settings.agentMode !== 'auto' &&
    !agentsKnown &&
    settings.agentSelectionIsUserSet &&
    settings.selectedAgentIds.some((id) => !registry.getAgent(id))
  ) {
    throw new RunStartRefusedError('generation.customAgentsUnavailable');
  }
  // Generated agents belong to the course they were generated for.
  const presetIds = settings.selectedAgentIds.filter((id) => {
    const agent = registry.getAgent(id);
    return !!agent && !agent.isGenerated;
  });
  // An empty preset selection is the default presets (the run resolves them).
  return settings.agentMode === 'auto'
    ? { mode: 'auto', presetAgentIds: presetIds }
    : { mode: 'preset', agentIds: presetIds };
}

/** The learner's narrator voice for the tts slot's provider, when the server narrates. */
export function selectedRunVoice(capabilities: ModelCapabilities): StartRunInput['voice'] {
  const selection = ttsSelection(capabilities);
  if (!selection || selection.providerId === 'browser-native-tts' || !selection.voice) {
    return undefined;
  }
  return {
    providerId: selection.providerId,
    voiceId: selection.voice,
    ...(selection.speed ? { speed: selection.speed } : {}),
  };
}

export async function startClassicRun(input: {
  requirement: string;
  /** The composer's ready materials (uploaded and extracted), in bundle order. */
  materialIds: readonly string[];
  interactive: boolean;
  taskEngine: boolean;
  capabilities: ModelCapabilities;
}): Promise<RunSnapshot> {
  const agents = await selectedRunAgents();
  const materialIds = [...input.materialIds];

  const profile = useUserProfileStore.getState();
  const learnerProfile =
    profile.nickname || profile.bio
      ? {
          ...(profile.nickname ? { nickname: profile.nickname } : {}),
          ...(profile.bio ? { bio: profile.bio } : {}),
        }
      : undefined;
  const voice = selectedRunVoice(input.capabilities);

  return startGenerationRun({
    requirement: input.requirement,
    materialIds,
    interactive: input.interactive,
    taskEngine: input.taskEngine,
    agents,
    ...(learnerProfile ? { learnerProfile } : {}),
    ...(voice ? { voice } : {}),
    // Uploaded for this run only: released when it completes or ends.
    ...(materialIds.length > 0 ? { releaseMaterials: true } : {}),
    outlineReview: 'wait',
  });
}

/** A start the server answered with a refusal (a 4xx): no run exists for it. */
export function startDefinitelyRefused(error: unknown): boolean {
  return error instanceof RunApiError && error.status >= 400 && error.status < 500;
}
