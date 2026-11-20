/**
 * Provider-neutral role-voice seam.
 *
 * Shared voice-resolution layers (`voice-resolver`, `narration-voice`) honor
 * explicit user and agent selections uniformly across providers, and delegate
 * optional provider-specific automatic role matching through this registry.
 */
import type { ConfiguredTTSVoice } from './types';
import { createMossRoleVoicePolicy, type RoleVoicePolicy } from './moss-tts';

export type { RoleVoicePolicy };

export interface RoleVoiceTarget {
  providerId: string;
  managed?: boolean;
  options?: Record<string, unknown>;
  voices?: readonly ConfiguredTTSVoice[];
}

type RoleVoicePolicyFactory = (target: RoleVoiceTarget) => RoleVoicePolicy | undefined;

const ROLE_VOICE_FACTORIES: Record<string, RoleVoicePolicyFactory> = {
  'openai-tts': createMossRoleVoicePolicy,
};

export function getRoleVoicePolicy(target: RoleVoiceTarget): RoleVoicePolicy | undefined {
  return ROLE_VOICE_FACTORIES[target.providerId]?.(target);
}
