/**
 * @deprecated Use lib/audio/voice-map.ts directly.
 * This file kept for backwards-compatibility — re-exports from voice-map.ts.
 */

export { EN_DEFAULTS, resolveVoice as resolveRoleVoice, resolveProvider } from '@/lib/audio/voice-map';
export type { ProviderVoiceEntry } from '@/lib/audio/voice-map';

import type { TTSProviderId } from '@/lib/audio/types';

export type AgentRole = 'teacher' | 'student' | 'assistant' | string;

export interface ResolvedRoleVoice {
  providerId: TTSProviderId;
  voice: string;
}
