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
import { VOXCPM_AUTO_VOICE_ID, VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';
import { ttsSelection } from '@/lib/audio/tts-selection';
import {
  effectiveVoiceDesign,
  pickNarratorAgent,
  resolveAgentVoiceOptionsFrom,
  type AgentVoiceResolveOptions,
} from '@/lib/audio/agent-voice-options';

export { pickNarratorAgent, type AgentVoiceResolveOptions };

/**
 * Produce the `ttsProviderOptions` to send to /api/generate/tts for `agent`
 * (pass the teacher agent for narration, the speaking agent for discussion,
 * or undefined when there is no agent). Returns undefined for providers with
 * no special options. VoxCPM options include what this browser keeps (its
 * voice profiles, a registered auto voice).
 */
export function resolveAgentVoiceOptions(
  agent: AgentConfig | undefined,
  opts: AgentVoiceResolveOptions,
): Promise<Record<string, unknown> | undefined> {
  return resolveAgentVoiceOptionsFrom(getVoxCPMProviderOptions, agent, opts);
}

/**
 * Eager warm-up: right after generated agents are saved, pre-register the
 * narrator's (teacher's) auto voice using the SAME idempotent ensure as the TTS
 * path, so the first spoken line is already stable. Only the narrator is warmed:
 * it always speaks (lecture narration), whereas discussion agents may never be
 * selected, so warming all of them would synthesize voices that go unused.
 * Fire-and-forget; the on-use ensure remains the correctness path for the rest.
 */
export function warmUpAgentVoices(agents: AgentConfig[]): void {
  const selection = ttsSelection();
  const providerId = selection?.providerId;
  if (providerId !== VOXCPM_TTS_PROVIDER_ID) return;
  const providerConfig = selection?.providersConfig[providerId];

  const narrator = pickNarratorAgent(agents);
  if (!narrator || !effectiveVoiceDesign(narrator)) return;
  void resolveAgentVoiceOptions(narrator, {
    providerId,
    providerConfig,
    voiceId: VOXCPM_AUTO_VOICE_ID,
  }).catch(() => undefined);
}
