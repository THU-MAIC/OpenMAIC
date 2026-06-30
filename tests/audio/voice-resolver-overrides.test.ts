/**
 * Per-agent voice overrides (persisted in settings) take precedence over the
 * agent's registry voiceConfig and the deterministic fallback, with the same
 * enablement validation as voiceConfig.
 */
import { describe, it, expect } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { resolveAgentVoice, type ProviderWithVoices } from '@/lib/audio/voice-resolver';

const agent = (id: string, voiceConfig?: AgentConfig['voiceConfig']) =>
  ({ id, voiceConfig }) as AgentConfig;

const qwen: ProviderWithVoices = {
  providerId: 'qwen-tts',
  providerName: 'Qwen TTS',
  voices: [
    { id: 'Cherry', name: 'Cherry' },
    { id: 'Dylan', name: 'Dylan' },
  ],
  modelGroups: [],
};

describe('resolveAgentVoice with overrides', () => {
  it('prefers the override over voiceConfig and fallback', () => {
    const resolved = resolveAgentVoice(
      agent('default-2', { providerId: 'qwen-tts', voiceId: 'Cherry' }),
      0,
      [qwen],
      { 'default-2': { providerId: 'qwen-tts', voiceId: 'Dylan' } },
    );
    expect(resolved).toEqual({ providerId: 'qwen-tts', modelId: undefined, voiceId: 'Dylan' });
  });

  it('ignores an override whose provider is not enabled, falling back to voiceConfig', () => {
    const resolved = resolveAgentVoice(
      agent('default-2', { providerId: 'qwen-tts', voiceId: 'Cherry' }),
      0,
      [qwen],
      { 'default-2': { providerId: 'openai-tts', voiceId: 'alloy' } },
    );
    expect(resolved).toEqual({ providerId: 'qwen-tts', modelId: undefined, voiceId: 'Cherry' });
  });

  it('ignores an override whose voice is unknown to the provider', () => {
    const resolved = resolveAgentVoice(agent('default-2'), 1, [qwen], {
      'default-2': { providerId: 'qwen-tts', voiceId: 'NotAVoice' },
    });
    // falls through to deterministic fallback: voices[1 % 2] = Dylan
    expect(resolved).toEqual({ providerId: 'qwen-tts', voiceId: 'Dylan' });
  });

  it('only applies the override of the matching agent id', () => {
    const resolved = resolveAgentVoice(agent('default-3'), 0, [qwen], {
      'default-2': { providerId: 'qwen-tts', voiceId: 'Dylan' },
    });
    expect(resolved).toEqual({ providerId: 'qwen-tts', voiceId: 'Cherry' });
  });

  it('honors a browser-native override only when browser-native is selectable', () => {
    const browserNative: ProviderWithVoices = {
      providerId: 'browser-native-tts',
      providerName: 'Browser',
      voices: [{ id: 'Anna', name: 'Anna' }],
      modelGroups: [],
    };
    const override = {
      'default-2': { providerId: 'browser-native-tts' as const, voiceId: 'Anna' },
    };
    expect(resolveAgentVoice(agent('default-2'), 0, [qwen], override)).toEqual({
      providerId: 'qwen-tts',
      voiceId: 'Cherry',
    });
    expect(resolveAgentVoice(agent('default-2'), 0, [qwen, browserNative], override)).toEqual({
      providerId: 'browser-native-tts',
      modelId: undefined,
      voiceId: 'Anna',
    });
  });
});
