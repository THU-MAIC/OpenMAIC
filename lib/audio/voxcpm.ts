import type { TTSVoiceInfo } from '@/lib/audio/types';

export const VOXCPM_TTS_PROVIDER_ID = 'voxcpm-tts' as const;
export const VOXCPM_MODEL_ID = 'VoxCPM2';
export const VOXCPM_VLLM_MODEL_ID = 'voxcpm2';
export const VOXCPM_AUTO_VOICE_ID = 'voxcpm:auto';
export const VOXCPM_PROFILE_VOICE_PREFIX = 'voxcpm:profile:';
const VOXCPM_AUTO_VOICE_PROMPT_MAX_CHARS = 200;

export const VOXCPM_BACKENDS = [
  {
    id: 'vllm-omni',
    name: 'vLLM-Omni',
    endpoint: '/v1/audio/speech',
    description: 'OpenAI-compatible speech endpoint',
  },
  {
    id: 'python-api',
    name: 'Python API',
    endpoint: '/tts/upload',
    description: 'FastAPI deployment backed by the VoxCPM Python runtime',
  },
  {
    id: 'nano-vllm',
    name: 'Nano-vLLM',
    endpoint: '/generate',
    description: 'Nano-vLLM VoxCPM FastAPI deployment',
  },
] as const;

export type VoxCPMBackendType = (typeof VOXCPM_BACKENDS)[number]['id'];

export const DEFAULT_VOXCPM_BACKEND: VoxCPMBackendType = 'vllm-omni';

export interface VoxCPMVoicePromptContext {
  agentName?: string;
  role?: string;
  persona?: string;
  language?: string;
  locale?: string;
}

export interface VoxCPMProviderOptions {
  backend?: VoxCPMBackendType;
  voiceMode?: 'auto' | 'prompt' | 'clone';
  voicePrompt?: string;
  promptText?: string;
  referenceAudioBase64?: string;
  referenceAudioMimeType?: string;
  referenceAudioName?: string;
  cfgValue?: number;
  inferenceTimesteps?: number;
  normalize?: boolean;
  denoise?: boolean;
}

export const VOXCPM_AUTO_VOICE: TTSVoiceInfo = {
  id: VOXCPM_AUTO_VOICE_ID,
  name: 'Auto Voice',
  language: 'auto',
  gender: 'neutral',
  description: 'Generate a voice prompt from agent metadata',
};

export function normalizeVoxCPMBackend(value: unknown): VoxCPMBackendType {
  return VOXCPM_BACKENDS.some((backend) => backend.id === value)
    ? (value as VoxCPMBackendType)
    : DEFAULT_VOXCPM_BACKEND;
}

export function getVoxCPMBackendEndpoint(backend: VoxCPMBackendType): string {
  return VOXCPM_BACKENDS.find((item) => item.id === backend)?.endpoint || '/v1/audio/speech';
}

export function voxCPMBackendSupportsReferenceAudio(backend: VoxCPMBackendType): boolean {
  return backend === 'vllm-omni' || backend === 'python-api' || backend === 'nano-vllm';
}

export function buildVoxCPMBackendUrl(baseUrl: string, backend: VoxCPMBackendType): string {
  const cleanBaseUrl = baseUrl.replace(/\/$/, '');
  if (backend === 'vllm-omni' && cleanBaseUrl.endsWith('/v1')) {
    return `${cleanBaseUrl}/audio/speech`;
  }
  return `${cleanBaseUrl}${getVoxCPMBackendEndpoint(backend)}`;
}

export function getVoxCPMProfileVoiceId(profileId: string): string {
  return `${VOXCPM_PROFILE_VOICE_PREFIX}${profileId}`;
}

export function getVoxCPMProfileIdFromVoiceId(voiceId: string): string | null {
  if (!voiceId.startsWith(VOXCPM_PROFILE_VOICE_PREFIX)) return null;
  return voiceId.slice(VOXCPM_PROFILE_VOICE_PREFIX.length);
}

function sanitizeAutoVoicePromptPart(value?: string): string {
  return (value || '')
    .replace(/[\p{C}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, VOXCPM_AUTO_VOICE_PROMPT_MAX_CHARS)
    .trim();
}

export function buildAutoVoxCPMVoicePrompt(context: VoxCPMVoicePromptContext = {}): string {
  const persona = sanitizeAutoVoicePromptPart(context.persona);
  if (persona) return persona;

  const fallbackParts = [context.role, context.agentName]
    .map(sanitizeAutoVoicePromptPart)
    .filter(Boolean);
  const fallbackPrompt = sanitizeAutoVoicePromptPart(fallbackParts.join(' '));
  return fallbackPrompt || 'natural classroom voice';
}
