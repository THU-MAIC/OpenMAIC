/**
 * Provider-neutral voice-registration seam.
 *
 * The "auto voice" timbre-stability pattern — synthesize a voice-design once,
 * register it, then reference it by id — is not VoxCPM-specific. Any TTS
 * backend that can register/clone a voice (VoxCPM/vLLM-Omni today; ElevenLabs,
 * MiniMax, Doubao, … later) plugs in by implementing `VoiceRegistrationAdapter`
 * and registering it below. Server routes and the client orchestrator dispatch
 * by `providerId` and never name a concrete provider.
 */

import type { VoiceDesign } from '@/lib/audio/voice-design';
import { qwenVoiceCloneRegistrationAdapter } from '@/lib/audio/qwen-voice-clone-registration';
import { voxcpmVoiceRegistrationAdapter } from '@/lib/audio/voxcpm-registration';

/** Resolved backend connection for a registration call (server-injected for managed providers). */
export interface VoiceRegistrationConfig {
  baseUrl: string;
  apiKey?: string;
  model?: string;
}

export interface VoiceRegistrationAdapter {
  /** Whether registration is available for this provider given its options (e.g. backend kind). */
  supportsRegistration(options?: Record<string, unknown>): boolean;
  /** Whether the adapter can synthesize its own reference clip from a voice design. */
  supportsBootstrapReferenceClip?: boolean;
  /**
   * The model this adapter's registration flow uses (enrollment target or the
   * synthesis model behind a bootstrap clip), resolved provider-side.
   * `clientModel` is a caller-supplied TTS model hint; the adapter decides
   * whether (and how) to honor it. `undefined` when registration is model-less.
   */
  resolveRegistrationModel(clientModel?: string): string | undefined;
  /** Whether `voiceId` is registered, or `unknown` when the lookup is inconclusive. */
  voiceExists(
    cfg: VoiceRegistrationConfig,
    voiceId: string,
    signal?: AbortSignal,
  ): Promise<boolean | 'unknown'>;
  /** Register (or idempotently re-register) a reference clip under `voiceId`; returns the id. */
  registerVoice(
    cfg: VoiceRegistrationConfig,
    params: {
      voiceId: string;
      referenceAudioBase64: string;
      mimeType?: string;
      refText?: string;
    },
    signal?: AbortSignal,
  ): Promise<string>;
  /** Delete a provider-side registered voice, when supported. */
  deleteVoice?(cfg: VoiceRegistrationConfig, voiceId: string, signal?: AbortSignal): Promise<void>;
  /** Synthesize the voice design once into a reference clip. */
  bootstrapReferenceClip(
    cfg: VoiceRegistrationConfig,
    params: { design: VoiceDesign; language?: string },
    signal?: AbortSignal,
  ): Promise<{ referenceAudioBase64: string; mimeType: string }>;
}

/** providerId → adapter. The only seam to touch when adding a provider. */
const VOICE_REGISTRATION_ADAPTERS: Record<string, VoiceRegistrationAdapter> = {
  'qwen-tts': qwenVoiceCloneRegistrationAdapter,
  'voxcpm-tts': voxcpmVoiceRegistrationAdapter,
};

export function getVoiceRegistrationAdapter(
  providerId: string,
): VoiceRegistrationAdapter | undefined {
  return VOICE_REGISTRATION_ADAPTERS[providerId];
}

/** Whether this provider supports register-once/reference-by-id for the given options. */
export function supportsVoiceRegistration(
  providerId: string,
  options?: Record<string, unknown>,
): boolean {
  return getVoiceRegistrationAdapter(providerId)?.supportsRegistration(options) ?? false;
}
