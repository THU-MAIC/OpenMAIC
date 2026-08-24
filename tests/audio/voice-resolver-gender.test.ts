/**
 * The deterministic fallback (no override, no voiceConfig) narrows the pool to
 * voices whose gender matches the agent before indexing into it.
 *
 * The fixture is ordered so that plain index round-robin returns a voice of the
 * WRONG gender: every assertion here fails if the gender filter is removed.
 */
import { describe, it, expect } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  resolveAgentVoice,
  inferAgentGender,
  type ProviderWithVoices,
} from '@/lib/audio/voice-resolver';

const provider: ProviderWithVoices = {
  providerId: 'minimax-tts',
  providerName: 'MiniMax TTS',
  voices: [
    { id: 'male-a', name: '精英青年', gender: 'male' },
    { id: 'female-b', name: '少女音色', gender: 'female' },
    { id: 'male-c', name: '温润男声', gender: 'male' },
    { id: 'neutral-d', name: 'Neutral', gender: 'neutral' },
  ],
  modelGroups: [],
};

const agent = (over: Partial<AgentConfig>) => ({ id: 'gen-1', ...over }) as AgentConfig;

describe('resolveAgentVoice — gender-aware fallback', () => {
  it('gives a female agent at index 0 a female voice, not the first voice in the list', () => {
    const resolved = resolveAgentVoice(agent({ gender: 'female' }), 0, [provider]);
    // Index round-robin would return 'male-a'.
    expect(resolved).toEqual({ providerId: 'minimax-tts', voiceId: 'female-b' });
  });

  it('gives a male agent at index 1 a male voice, not the second voice in the list', () => {
    const resolved = resolveAgentVoice(agent({ gender: 'male' }), 1, [provider]);
    // Index round-robin would return 'female-b'; the male+neutral pool is
    // [male-a, male-c, neutral-d] and index 1 lands on 'male-c'.
    expect(resolved).toEqual({ providerId: 'minimax-tts', voiceId: 'male-c' });
  });

  it('still rotates across the matching voices as the index advances', () => {
    const first = resolveAgentVoice(agent({ gender: 'female' }), 0, [provider]);
    const second = resolveAgentVoice(agent({ gender: 'female' }), 1, [provider]);
    expect(first?.voiceId).toBe('female-b');
    expect(second?.voiceId).toBe('neutral-d');
  });

  it('keeps the plain index behaviour when the agent has no gender information', () => {
    const resolved = resolveAgentVoice(agent({}), 1, [provider]);
    expect(resolved).toEqual({ providerId: 'minimax-tts', voiceId: 'female-b' });
  });

  it('falls back to the full list when no voice matches the wanted gender', () => {
    const maleOnly: ProviderWithVoices = {
      ...provider,
      voices: [{ id: 'male-a', name: '精英青年', gender: 'male' }],
    };
    const resolved = resolveAgentVoice(agent({ gender: 'female' }), 0, [maleOnly]);
    expect(resolved).toEqual({ providerId: 'minimax-tts', voiceId: 'male-a' });
  });

  it('leaves a gender-less catalogue on the plain index behaviour', () => {
    const unlabelled: ProviderWithVoices = {
      ...provider,
      voices: [
        { id: 'v0', name: 'V0' },
        { id: 'v1', name: 'V1' },
      ],
    };
    const resolved = resolveAgentVoice(agent({ gender: 'female' }), 1, [unlabelled]);
    expect(resolved).toEqual({ providerId: 'minimax-tts', voiceId: 'v1' });
  });
});

describe('inferAgentGender', () => {
  it('prefers the explicit field over the voiceDesign prose', () => {
    expect(
      inferAgentGender(
        agent({
          gender: 'female',
          voiceDesign: { identity: 'middle-aged male teacher', texture: '', delivery: '' },
        }),
      ),
    ).toBe('female');
  });

  it('reads the English voiceDesign identity when there is no explicit field', () => {
    expect(
      inferAgentGender(
        agent({
          voiceDesign: { identity: 'middle-aged female teacher', texture: '', delivery: '' },
        }),
      ),
    ).toBe('female');
  });

  it('does not read "male" out of "female"', () => {
    expect(
      inferAgentGender(
        agent({ voiceDesign: { identity: 'young female student', texture: '', delivery: '' } }),
      ),
    ).toBe('female');
  });

  it('returns undefined for neutral, ambiguous, or absent information', () => {
    expect(inferAgentGender(agent({ gender: 'neutral' }))).toBeUndefined();
    expect(
      inferAgentGender(
        agent({ voiceDesign: { identity: 'a male or female voice', texture: '', delivery: '' } }),
      ),
    ).toBeUndefined();
    expect(inferAgentGender(agent({}))).toBeUndefined();
  });

  it('returns undefined for a non-English identity rather than guessing', () => {
    // The generator writes voiceDesign in the course language; this is exactly
    // why the explicit `gender` field exists.
    expect(
      inferAgentGender(
        agent({ voiceDesign: { identity: 'professora de meia-idade', texture: '', delivery: '' } }),
      ),
    ).toBeUndefined();
  });
});
