import { isKnownTTSProviderId, voiceAllowedByConfiguredCatalogue } from '@/lib/audio/constants';
import { slotTTSModel } from '@/lib/audio/tts-selection';
import type { EffectiveTarget } from '@/lib/model-settings/capabilities';
import type { LearningView } from './types';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { AgentRole } from './domain/project/project-schema';

/** Who the learner sees speaking in each role: a face and a name key under `pblV3.personas`. */
export const ROLE_PERSONAS: Record<AgentRole, { avatar: string; color: string }> = {
  mentor: { avatar: '/avatars/teacher.png', color: '#7c3aed' },
  discussion: { avatar: '/avatars/curious.png', color: '#0284c7' },
  planner: { avatar: '/avatars/thinker.png', color: '#059669' },
  coder: { avatar: '/avatars/note-taker.png', color: '#d97706' },
};

const EPOCH = new Date(0);
/** A package selects a voice on the host's active service. The player handles playback and fallback. */
export function pblNarrators(
  roleVoices: LearningView['roleVoices'],
  target: EffectiveTarget | null,
): AgentConfig[] {
  return (Object.keys(ROLE_PERSONAS) as AgentRole[]).map((role, index) => {
    const voice = roleVoices?.[role];
    const voiceConfig =
      voice &&
      target &&
      voice.providerId === target.registryId &&
      isKnownTTSProviderId(voice.providerId) &&
      (!voice.modelId || voice.modelId === slotTTSModel(target)) &&
      voiceAllowedByConfiguredCatalogue(voice.providerId, voice.voiceId, target.voices)
        ? { ...voice, providerId: voice.providerId }
        : undefined;
    return {
      id: role,
      name: role,
      role: 'teacher',
      persona: '',
      ...ROLE_PERSONAS[role],
      voiceConfig,
      allowedActions: [],
      priority: 10 - index,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      isDefault: true,
    };
  });
}
