/**
 * A run narrates with the browser's voice decisions: the slot voice or the
 * teacher's bound voice, the deterministic pick for an unusable pinned
 * narrator, the single retry after a missing clone, and the teacher's VoxCPM
 * options.
 */
import { describe, expect, it } from 'vitest';

import { resolveServerAgentVoiceOptions } from '@/lib/audio/agent-voice-options';
import { voiceBindingKey } from '@/lib/audio/unavailable-voice-bindings';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  clipVoice,
  clipVoiceAfterMissingClone,
  type RunNarrationTarget,
} from '@/lib/server/generation/run/narration-voice';
import type { MediaConnection } from '@/lib/server/model-config/media';

const qwen: RunNarrationTarget = {
  connection: {
    providerId: 'qwen-tts',
    managed: true,
    userEndpoint: false,
    origin: 'configuration',
  } as MediaConnection,
  providerId: 'qwen-tts',
  modelId: 'qwen3-tts-flash',
};
const clone = { providerId: 'qwen-tts' as const, voiceId: 'qwen-tts-vc-clone-1' };

describe('run narration voices', () => {
  it("uses the learner's voice for the slot's provider, else the provider default", () => {
    expect(
      clipVoice({
        target: qwen,
        preference: { providerId: 'qwen-tts', voiceId: 'Ethan' },
        bound: undefined,
        unavailable: new Set(),
      })?.voice.voiceId,
    ).toBe('Ethan');
    expect(
      clipVoice({
        target: qwen,
        preference: { providerId: 'openai-tts', voiceId: 'alloy' },
        bound: undefined,
        unavailable: new Set(),
      })?.voice.voiceId,
    ).toBe('Cherry');
  });

  it('prefers the bound teacher voice until this run found it unusable', () => {
    const bound = clipVoice({
      target: qwen,
      preference: undefined,
      bound: clone,
      unavailable: new Set(),
    });
    expect(bound?.voice.voiceId).toBe(clone.voiceId);
    const skipped = clipVoice({
      target: qwen,
      preference: undefined,
      bound: clone,
      unavailable: new Set([voiceBindingKey(clone)]),
    });
    expect(skipped?.voice.voiceId).toBe('Cherry');
  });

  it('retries a missing clone once: with the slot voice when the binding differs from it', () => {
    const chosen = clipVoice({
      target: qwen,
      preference: undefined,
      bound: clone,
      unavailable: new Set(),
    })!;
    expect(
      clipVoiceAfterMissingClone({
        target: qwen,
        bound: clone,
        globalVoice: chosen.globalVoice,
        failed: chosen.voice,
        usedFallbackVoice: false,
      })?.voiceId,
    ).toBe('Cherry');
    // A clip that did not use the binding is not retried.
    expect(
      clipVoiceAfterMissingClone({
        target: qwen,
        bound: clone,
        globalVoice: chosen.globalVoice,
        failed: chosen.globalVoice,
        usedFallbackVoice: false,
      }),
    ).toBeNull();
  });

  it('retries a pinned narrator (bound == slot voice) with the deterministic pick, once', () => {
    const pinned = clipVoice({
      target: qwen,
      preference: { providerId: 'qwen-tts', voiceId: clone.voiceId },
      bound: clone,
      unavailable: new Set(),
    })!;
    const retry = clipVoiceAfterMissingClone({
      target: qwen,
      bound: clone,
      globalVoice: pinned.globalVoice,
      failed: pinned.voice,
      usedFallbackVoice: false,
    });
    expect(retry).toMatchObject({ providerId: 'qwen-tts' });
    expect(retry?.voiceId).not.toBe(clone.voiceId);
    expect(
      clipVoiceAfterMissingClone({
        target: qwen,
        bound: clone,
        globalVoice: pinned.globalVoice,
        failed: pinned.voice,
        usedFallbackVoice: true,
      }),
    ).toBeNull();
  });

  it('gives the VoxCPM auto voice its prompt from the teacher, as the browser does', async () => {
    const teacher = {
      id: 't',
      name: 'Ada',
      role: 'teacher',
      persona: 'Warm and patient.',
    } as AgentConfig;
    expect(
      await resolveServerAgentVoiceOptions(teacher, {
        providerId: 'voxcpm-tts',
        providerConfig: { providerOptions: { backend: 'vllm-omni' } },
        voiceId: 'voxcpm:auto',
        language: 'Use English.',
      }),
    ).toEqual({ backend: 'vllm-omni', voiceMode: 'auto', voicePrompt: 'Warm and patient.' });
    expect(
      await resolveServerAgentVoiceOptions(teacher, { providerId: 'openai-tts', voiceId: 'alloy' }),
    ).toBeUndefined();
  });
});
