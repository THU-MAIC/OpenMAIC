'use client';

/**
 * Single source of truth for "an agent's TTS voice".
 *
 * Every TTS path (lecture narration, multi-agent discussion, voice preview,
 * settings test) resolves voice options through `resolveAgentVoiceOptions`,
 * which reads the agent profile (`voiceConfig` + `voiceDesign`) and, for
 * registration-capable providers, ensures the auto voice is registered and
 * referenced by id (stable timbre) — otherwise falls back to the inline
 * voice-design prompt. There is no second code path to drift out of sync.
 */

import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { getVoxCPMProviderOptions } from '@/lib/audio/voxcpm-voices';
import {
  VOXCPM_AUTO_VOICE_ID,
  VOXCPM_TTS_PROVIDER_ID,
  normalizeVoxCPMBackend,
} from '@/lib/audio/voxcpm';
import { useSettingsStore } from '@/lib/store/settings';

interface TTSProviderConfigShape {
  apiKey?: string;
  baseUrl?: string;
  customDefaultBaseUrl?: string;
  modelId?: string;
  providerOptions?: Record<string, unknown>;
}

export interface AgentVoiceResolveOptions {
  providerId: string;
  providerConfig?: TTSProviderConfigShape;
  voiceId: string;
  /** Course language / locale — only selects the one-time bootstrap sample sentence. */
  language?: string;
}

/**
 * Pick the agent whose voice narration should use (the teacher).
 *
 * The registry is always seeded with the DEFAULT agents, so a plain
 * `find(role === 'teacher')` returns the default teacher (no voiceDesign) even
 * when a generated classroom is active. Prefer a teacher that actually carries a
 * voiceDesign (the generated one) so narration registers a real voice instead of
 * drifting on the inline prompt; fall back to any teacher.
 */
export function pickNarratorAgent(agents: AgentConfig[]): AgentConfig | undefined {
  return (
    agents.find((a) => a.role === 'teacher' && a.voiceDesign) ??
    agents.find((a) => a.role === 'teacher')
  );
}

/**
 * Produce the `ttsProviderOptions` to send to /api/generate/tts for `agent`
 * (pass the teacher agent for narration, the speaking agent for discussion,
 * or undefined when there is no agent). Returns undefined for providers with
 * no special options.
 */
export async function resolveAgentVoiceOptions(
  agent: AgentConfig | undefined,
  opts: AgentVoiceResolveOptions,
): Promise<Record<string, unknown> | undefined> {
  if (opts.providerId !== VOXCPM_TTS_PROVIDER_ID) return undefined;
  return {
    ...(opts.providerConfig?.providerOptions || {}),
    ...(await getVoxCPMProviderOptions(
      opts.voiceId,
      {
        agentName: agent?.name,
        role: agent?.role ?? 'teacher',
        persona: agent?.persona,
        voiceDesign: agent?.voiceDesign,
        language: opts.language,
        backend: normalizeVoxCPMBackend(opts.providerConfig?.providerOptions?.backend),
      },
      {
        ttsApiKey: opts.providerConfig?.apiKey || undefined,
        ttsBaseUrl:
          opts.providerConfig?.baseUrl || opts.providerConfig?.customDefaultBaseUrl || undefined,
        ttsModelId: opts.providerConfig?.modelId,
      },
    )),
  };
}

/**
 * Eager warm-up: right after generated agents are saved, pre-register each
 * agent's auto voice using the SAME idempotent ensure as the TTS path, so the
 * first spoken line is already stable (no first-utterance registration stall).
 * Fire-and-forget; the on-use ensure remains the correctness path (handles
 * provider switch / GC / cache miss via the deterministic id).
 */
export function warmUpAgentVoices(agents: AgentConfig[]): void {
  const settings = useSettingsStore.getState();
  const providerId = settings.ttsProviderId;
  if (providerId !== VOXCPM_TTS_PROVIDER_ID) return;
  const providerConfig = settings.ttsProvidersConfig?.[providerId];

  for (const agent of agents) {
    if (!agent.voiceDesign) continue;
    const assigned = agent.voiceConfig?.voiceId;
    if (assigned && assigned !== VOXCPM_AUTO_VOICE_ID) continue; // uses a specific voice, not auto
    void resolveAgentVoiceOptions(agent, {
      providerId,
      providerConfig,
      voiceId: VOXCPM_AUTO_VOICE_ID,
    }).catch(() => undefined);
  }
}
