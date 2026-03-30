/**
 * Role-based TTS voice map.
 *
 * Defines which provider + voice to use per agent role per course language.
 * - uz / zh-CN: hardcoded, not user-configurable.
 * - en-US: uses user settings with fallback defaults.
 *
 * Used by both server-side (classroom-media-generation.ts)
 * and client-side (use-scene-generator.ts) TTS generation.
 */

import type { TTSProviderId } from '@/lib/audio/types';

export type AgentRole = 'teacher' | 'student' | 'assistant' | string;

export interface ResolvedRoleVoice {
  providerId: TTSProviderId;
  voice: string;
}

// Defaults for English — used when user hasn't configured custom voices
export const EN_DEFAULTS = {
  teacher: { providerId: 'openai-tts' as TTSProviderId, voice: 'af_nova' },
  student: { providerId: 'openai-tts' as TTSProviderId, voice: 'am_echo' },
};

// Hardcoded map for Uzbek and Chinese
const HARDCODED_MAP: Record<string, Record<string, ResolvedRoleVoice>> = {
  uz: {
    teacher:   { providerId: 'azure-tts', voice: 'uz-UZ-MadinaNeural' },
    student:   { providerId: 'azure-tts', voice: 'uz-UZ-SardorNeural' },
    assistant: { providerId: 'azure-tts', voice: 'uz-UZ-SardorNeural' },
  },
  'zh-CN': {
    teacher:   { providerId: 'openai-tts', voice: 'zf_xiaoxiao' },
    student:   { providerId: 'openai-tts', voice: 'zm_yunxi' },
    assistant: { providerId: 'openai-tts', voice: 'zm_yunxi' },
  },
};

/**
 * Resolve provider + voice for a given course language and agent role.
 *
 * @param language  Course language: 'uz' | 'zh-CN' | 'en-US'
 * @param role      Agent role: 'teacher' | 'student' | 'assistant' | any string
 * @param enVoices  Optional user-configured English voices (from settings store)
 */
export function resolveRoleVoice(
  language: string,
  role: AgentRole,
  enVoices?: { teacherVoice?: string; studentVoice?: string },
): ResolvedRoleVoice {
  // Uzbek and Chinese — always hardcoded
  const hardcoded = HARDCODED_MAP[language];
  if (hardcoded) {
    return hardcoded[role] ?? hardcoded['student'] ?? hardcoded['teacher'];
  }

  // English (and any other language) — configurable with fallback
  const isTeacher = role === 'teacher';
  const voice = isTeacher
    ? (enVoices?.teacherVoice || EN_DEFAULTS.teacher.voice)
    : (enVoices?.studentVoice || EN_DEFAULTS.student.voice);

  return { providerId: 'openai-tts', voice };
}
