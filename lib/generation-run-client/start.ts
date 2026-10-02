/**
 * Start a classic generation as a server-side run: upload the course
 * materials to the owner's library, then submit the run input the composer
 * describes. The server resolves every model and provider; the browser sends
 * the learner's choices only (agents, learner profile, narrator voice).
 */
import { ttsSelection } from '@/lib/audio/tts-selection';
import type { ModelCapabilities } from '@/lib/model-settings/capabilities';
import { useAgentRegistry, whenAgentRegistryLoaded } from '@/lib/orchestration/registry/store';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserProfileStore } from '@/lib/store/user-profile';

import {
  fetchMaterialPolicy,
  listActiveGenerationRuns,
  RunApiError,
  type RunLimits,
  materialMime,
  startGenerationRun,
  uploadMaterial,
  type StartRunInput,
} from './api';
import { runInProgress } from './owner-runs';
import type { RunSnapshot } from './types';

/** A start refused before anything was submitted; `reason` is the translation key that says why. */
export class RunStartRefusedError extends Error {
  constructor(
    readonly reason:
      | 'generation.customAgentsUnavailable'
      | 'upload.unsupportedCourseMaterial'
      | 'upload.courseMaterialCountLimit'
      | 'upload.courseMaterialTotalSizeLimit',
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

/** Whether one more run would be refused: as many in progress, or waiting, as allowed. */
export function wouldExceedRunLimits(
  runs: ReadonlyArray<Pick<RunSnapshot, 'state'>>,
  limits: RunLimits,
): boolean {
  const inProgress = runs.filter((run) => runInProgress(run)).length;
  const waiting = runs.filter((run) => run.state === 'awaiting_outline_confirmation').length;
  return inProgress >= limits.maxActive || waiting >= limits.maxWaiting;
}

export async function startClassicRun(input: {
  requirement: string;
  materials: readonly File[];
  interactive: boolean;
  taskEngine: boolean;
  capabilities: ModelCapabilities;
}): Promise<RunSnapshot> {
  const agents = await selectedRunAgents();

  let materialIds: string[] = [];
  if (input.materials.length > 0) {
    // Nothing is uploaded for a start the limits would refuse (the start
    // checks again: this read can race another tab).
    const { runs, limits } = await listActiveGenerationRuns();
    if (limits && wouldExceedRunLimits(runs, limits)) {
      throw new RunApiError(429, 'ACTIVE_RUN_LIMIT', undefined, 'generation.activeRunLimit');
    }
    // Only what an extractor on this server reads is uploaded.
    const policy = await fetchMaterialPolicy();
    if (input.materials.length > policy.maxCount) {
      throw new RunStartRefusedError('upload.courseMaterialCountLimit', { n: policy.maxCount });
    }
    const totalBytes = input.materials.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > policy.maxTotalBytes) {
      throw new RunStartRefusedError('upload.courseMaterialTotalSizeLimit', {
        n: Math.floor(policy.maxTotalBytes / 1024 / 1024),
      });
    }
    const supported = new Set(policy.formats.map((format) => format.mime));
    if (input.materials.some((file) => !supported.has(materialMime(file)))) {
      throw new RunStartRefusedError('upload.unsupportedCourseMaterial');
    }
    materialIds = [];
    for (const file of input.materials) materialIds.push(await uploadMaterial(file));
  }

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
    outlineReview: 'wait',
  });
}
