import type { TTSVoiceInfo } from '@/lib/audio/types';

export const VOXCPM_TTS_PROVIDER_ID = 'voxcpm-tts' as const;
export const VOXCPM_MODEL_ID = 'VoxCPM2';
export const VOXCPM_VLLM_MODEL_ID = 'voxcpm2';
export const VOXCPM_AUTO_VOICE_ID = 'voxcpm:auto';
export const VOXCPM_PROFILE_VOICE_PREFIX = 'voxcpm:profile:';
export const VOXCPM_REGISTERED_VOICE_PREFIX = 'voxcpm:voice:' as const;
const VOXCPM_AUTO_VOICE_PROMPT_MAX_CHARS = 200;

/**
 * Per-agent voice-design descriptor (the 3-layer recipe). Describes vocal
 * identity, not personality — fed to VoxCPM auto voice for a real timbre.
 */
export interface VoxCPMVoiceDesign {
  identity: string; // gender / age / role
  texture: string; // pitch / vocal quality
  delivery: string; // emotion / pace
}

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
  voiceDesign?: VoxCPMVoiceDesign;
  backend?: VoxCPMBackendType;
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
  registeredVoiceId?: string;
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

/**
 * Compose the 3-layer descriptor into a single voice-design prompt
 * ("identity, texture, delivery"), dropping blank layers.
 */
export function buildVoiceDesignPrompt(design: VoxCPMVoiceDesign): string {
  return [design.identity, design.texture, design.delivery]
    .map((part) => sanitizeAutoVoicePromptPart(part))
    .filter(Boolean)
    .join(', ');
}

/**
 * Coerce an arbitrary (LLM-produced) value into a VoxCPMVoiceDesign.
 * Returns undefined when no layer carries content.
 */
export function normalizeVoiceDesign(raw: unknown): VoxCPMVoiceDesign | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const pick = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const design = {
    identity: pick(record.identity),
    texture: pick(record.texture),
    delivery: pick(record.delivery),
  };
  if (!design.identity && !design.texture && !design.delivery) return undefined;
  return design;
}

/**
 * Whether a backend exposes a runtime voice-registration API
 * (POST /v1/audio/voices) for reference-by-id timbre stability.
 */
export function voxCPMBackendSupportsVoiceRegistration(backend: VoxCPMBackendType): boolean {
  return backend === 'vllm-omni';
}

/**
 * Deterministic voice id derived from the descriptor (+ language + model).
 * Stable across re-synthesis and recomputable anywhere from the descriptor,
 * so registration is idempotent and needs no separately persisted id.
 */
export async function getDeterministicVoxCPMVoiceId(
  design: VoxCPMVoiceDesign,
  opts: { language?: string; model?: string } = {},
): Promise<string> {
  const seed = [
    design.identity,
    design.texture,
    design.delivery,
    opts.language || '',
    opts.model || VOXCPM_MODEL_ID,
  ].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${VOXCPM_REGISTERED_VOICE_PREFIX}${hex.slice(0, 16)}`;
}

export function buildAutoVoxCPMVoicePrompt(context: VoxCPMVoicePromptContext = {}): string {
  if (context.voiceDesign) {
    const designPrompt = sanitizeAutoVoicePromptPart(buildVoiceDesignPrompt(context.voiceDesign));
    if (designPrompt) return designPrompt;
  }

  const persona = sanitizeAutoVoicePromptPart(context.persona);
  if (persona) return persona;

  const fallbackParts = [context.role, context.agentName]
    .map(sanitizeAutoVoicePromptPart)
    .filter(Boolean);
  const fallbackPrompt = sanitizeAutoVoicePromptPart(fallbackParts.join(' '));
  return fallbackPrompt || 'natural classroom voice';
}
