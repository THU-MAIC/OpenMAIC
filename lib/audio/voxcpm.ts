import type { TTSVoiceInfo } from '@/lib/audio/types';

export const VOXCPM_TTS_PROVIDER_ID = 'voxcpm-tts' as const;
export const VOXCPM_MODEL_ID = 'VoxCPM2';
export const VOXCPM_VLLM_MODEL_ID = 'voxcpm2';
export const VOXCPM_AUTO_VOICE_ID = 'voxcpm:auto';
export const VOXCPM_PROFILE_VOICE_PREFIX = 'voxcpm:profile:';

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
  name: '自动音色',
  language: 'zh',
  gender: 'neutral',
  description: '根据 Agent 角色自动生成音色提示词',
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

export function buildAutoVoxCPMVoicePrompt(context: VoxCPMVoicePromptContext = {}): string {
  const role = context.role?.toLowerCase() || '';
  const persona = context.persona || '';
  const combined = `${role}\n${persona}`;

  const gender =
    /女|female|girl|woman/i.test(combined) && !/男|male|boy|man/i.test(combined)
      ? '女声'
      : /男|male|boy|man/i.test(combined)
        ? '男声'
        : '中性声音';

  const roleTone = role.includes('student')
    ? '年轻、自然、带有好奇心'
    : role.includes('assistant')
      ? '友好、清晰、善于引导'
      : '专业、清晰、富有教学感';

  const namePart = context.agentName ? `，适合角色${context.agentName}` : '';
  return `${roleTone}的中文${gender}${namePart}，语速适中，吐字清楚，情绪自然，适合AI课堂对话`;
}
