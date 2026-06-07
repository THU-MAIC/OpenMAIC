/**
 * Tests for voice-resolver under the unified enablement model (#665):
 *  - getEnabledProvidersWithVoices includes only enabled providers and never
 *    browser-native;
 *  - resolveAgentVoice is deterministic among enabled providers, honors a still
 *    -enabled voiceConfig, never auto-assigns browser-native, and returns null
 *    when nothing is enabled (no hardcoded fallback).
 */
import { describe, it, expect } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  getEnabledProvidersWithVoices,
  getSelectableProvidersWithVoices,
  resolveAgentVoice,
  type ProviderWithVoices,
} from '@/lib/audio/voice-resolver';

const agent = (voiceConfig?: AgentConfig['voiceConfig']) => ({ voiceConfig }) as AgentConfig;

describe('getEnabledProvidersWithVoices', () => {
  it('includes configured+enabled providers, excludes disabled/unconfigured/browser-native', () => {
    const providers = getEnabledProvidersWithVoices({
      'openai-tts': { apiKey: 'k', enabled: true },
      'qwen-tts': { apiKey: 'k', enabled: false }, // user-disabled
      'glm-tts': { apiKey: 'k', serverDisabled: true }, // server-disabled
      'lemonade-tts': {}, // not configured (defaultBaseUrl dropped)
      'browser-native-tts': { enabled: true }, // never in this list
    });
    const ids = providers.map((p) => p.providerId);
    expect(ids).toContain('openai-tts');
    expect(ids).not.toContain('qwen-tts');
    expect(ids).not.toContain('glm-tts');
    expect(ids).not.toContain('lemonade-tts');
    expect(ids).not.toContain('browser-native-tts');
  });
});

describe('resolveAgentVoice', () => {
  const openai: ProviderWithVoices = {
    providerId: 'openai-tts',
    providerName: 'OpenAI TTS',
    voices: [
      { id: 'alloy', name: 'Alloy' },
      { id: 'echo', name: 'Echo' },
    ],
    modelGroups: [],
  };

  it('returns null when nothing is enabled (no silent browser-native fallback)', () => {
    expect(resolveAgentVoice(agent(), 0, [])).toBeNull();
  });

  it('deterministically picks among enabled providers by agent index', () => {
    expect(resolveAgentVoice(agent(), 0, [openai])).toEqual({
      providerId: 'openai-tts',
      voiceId: 'alloy',
    });
    expect(resolveAgentVoice(agent(), 1, [openai])).toEqual({
      providerId: 'openai-tts',
      voiceId: 'echo',
    });
    // index wraps deterministically
    expect(resolveAgentVoice(agent(), 2, [openai])?.voiceId).toBe('alloy');
  });

  it('honors a voiceConfig only when its provider is still enabled', () => {
    const cfg = { providerId: 'openai-tts' as const, voiceId: 'echo' };
    expect(resolveAgentVoice(agent(cfg), 0, [openai])).toEqual({
      providerId: 'openai-tts',
      modelId: undefined,
      voiceId: 'echo',
    });
    // provider not in enabled list ⇒ fall back to deterministic pick (not the
    // stale voiceConfig)
    expect(resolveAgentVoice(agent(cfg), 0, [])).toBeNull();
  });

  it('never auto-assigns browser-native, but honors it as an explicit choice', () => {
    const bn = { providerId: 'browser-native-tts' as const, voiceId: 'default' };
    // browser-native not in the enabled list ⇒ explicit config ignored, no fallback
    expect(resolveAgentVoice(agent(bn), 0, [openai])).toEqual({
      providerId: 'openai-tts',
      voiceId: 'alloy',
    });
    // browser-native present (user enabled it) ⇒ explicit choice honored
    const withBn: ProviderWithVoices = {
      providerId: 'browser-native-tts',
      providerName: 'Browser Native',
      voices: [{ id: 'default', name: 'Default' }],
      modelGroups: [],
    };
    expect(resolveAgentVoice(agent(bn), 0, [openai, withBn])).toEqual({
      providerId: 'browser-native-tts',
      modelId: undefined,
      voiceId: 'default',
    });
  });
});

describe('getSelectableProvidersWithVoices (unified picker + discussion source)', () => {
  const cfg = {
    'qwen-tts': { apiKey: 'k', enabled: true },
    'browser-native-tts': { enabled: true },
  };
  const bn = [{ voiceURI: 'os-zh', name: 'OS Chinese' }];

  it('= enabled providers + browser-native when enabled AND browser exposes voices', () => {
    const ids = getSelectableProvidersWithVoices(cfg, [], bn).map((p) => p.providerId);
    expect(ids).toContain('qwen-tts');
    expect(ids).toContain('browser-native-tts');
  });

  it('omits browser-native when the browser exposes no voices (e.g. headless)', () => {
    const ids = getSelectableProvidersWithVoices(cfg, [], []).map((p) => p.providerId);
    expect(ids).toContain('qwen-tts');
    expect(ids).not.toContain('browser-native-tts');
  });

  it('omits browser-native when the user has not enabled it', () => {
    const ids = getSelectableProvidersWithVoices(
      { 'qwen-tts': { apiKey: 'k', enabled: true }, 'browser-native-tts': { enabled: false } },
      [],
      bn,
    ).map((p) => p.providerId);
    expect(ids).not.toContain('browser-native-tts');
  });

  it('lets the teacher path (global voice as synthetic voiceConfig) and a student resolve through the SAME list — both audible when a provider is selectable', () => {
    const providers = getSelectableProvidersWithVoices(cfg, [], bn);
    // teacher: global selection = browser-native (only client-dynamic provider)
    const teacher = {
      role: 'teacher',
      voiceConfig: { providerId: 'browser-native-tts' as const, voiceId: 'os-zh' },
    } as AgentConfig;
    expect(resolveAgentVoice(teacher, 0, providers)?.providerId).toBe('browser-native-tts');
    // student with no voiceConfig falls back deterministically to an enabled provider — not null
    const student = {} as AgentConfig;
    expect(resolveAgentVoice(student, 0, providers)).not.toBeNull();
  });
});
