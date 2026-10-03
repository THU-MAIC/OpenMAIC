/**
 * An agent's TTS voice options, shared by the browser (`agent-voice.ts`) and
 * server-side generation runs: which agent narrates, what describes its
 * voice, and the provider options a voice needs. Only where the options come
 * from differs — the browser also reads what it keeps locally (VoxCPM
 * profiles, registered voices); the server has the voice prompt alone.
 */
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { VoiceDesign } from '@/lib/audio/voice-design';
import {
  VOXCPM_TTS_PROVIDER_ID,
  normalizeVoxCPMBackend,
  voxCPMPromptProviderOptions,
  type VoxCPMProviderOptions,
  type VoxCPMVoicePromptContext,
} from '@/lib/audio/voxcpm';

/** What a voice's options depend on: the model (the provider's key and endpoint stay on the server). */
export interface TTSProviderConfigShape {
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

/** Where a VoxCPM voice's options come from. */
export type VoxCPMOptionsSource = (
  voiceId: string,
  context: VoxCPMVoicePromptContext,
  request: { ttsModelId?: string },
) => Promise<VoxCPMProviderOptions>;

/**
 * Pick the agent whose voice narration should use (the teacher).
 *
 * The registry is always seeded with the DEFAULT agents, so a plain
 * `find(role === 'teacher')` returns the default teacher (no voice binding or
 * design) even when a generated classroom is active. Prefer an explicit
 * voiceConfig first, then a teacher carrying voiceDesign, and finally any teacher.
 */
export function pickNarratorAgent(agents: AgentConfig[]): AgentConfig | undefined {
  return (
    agents.find((a) => a.role === 'teacher' && a.voiceConfig) ??
    agents.find((a) => a.role === 'teacher' && a.voiceDesign) ??
    agents.find((a) => a.role === 'teacher')
  );
}

/**
 * The descriptor used to bootstrap an agent's voice: the real `voiceDesign`
 * when present (generated agents), otherwise the persona as a fallback seed.
 * Persona is not a vocal description, so the resulting voice is stable but
 * generic — good enough to register a consistent reference clip (no drift),
 * pending a real descriptor if quality matters for that agent.
 */
export function effectiveVoiceDesign(agent: AgentConfig | undefined): VoiceDesign | undefined {
  if (agent?.voiceDesign) return agent.voiceDesign;
  const persona = agent?.persona?.trim();
  return persona ? { identity: persona, texture: '', delivery: '' } : undefined;
}

/**
 * The `ttsProviderOptions` for `agent`'s voice (the teacher for narration,
 * the speaking agent for discussion, or undefined when there is no agent).
 * Undefined for providers with no special options.
 */
export async function resolveAgentVoiceOptionsFrom(
  source: VoxCPMOptionsSource,
  agent: AgentConfig | undefined,
  opts: AgentVoiceResolveOptions,
): Promise<Record<string, unknown> | undefined> {
  if (opts.providerId !== VOXCPM_TTS_PROVIDER_ID) return undefined;
  return {
    ...(opts.providerConfig?.providerOptions || {}),
    ...(await source(
      opts.voiceId,
      {
        agentName: agent?.name,
        role: agent?.role ?? 'teacher',
        persona: agent?.persona,
        voiceDesign: effectiveVoiceDesign(agent),
        language: opts.language,
        backend: normalizeVoxCPMBackend(opts.providerConfig?.providerOptions?.backend),
      },
      { ttsModelId: opts.providerConfig?.modelId },
    )),
  };
}

/** {@link resolveAgentVoiceOptionsFrom} with nothing the browser keeps: the server's options. */
export function resolveServerAgentVoiceOptions(
  agent: AgentConfig | undefined,
  opts: AgentVoiceResolveOptions,
): Promise<Record<string, unknown> | undefined> {
  return resolveAgentVoiceOptionsFrom(
    async (voiceId, context) => voxCPMPromptProviderOptions(voiceId, context),
    agent,
    opts,
  );
}
