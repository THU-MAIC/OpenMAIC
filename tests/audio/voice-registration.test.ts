import { describe, it, expect } from 'vitest';
import {
  getVoiceRegistrationAdapter,
  supportsVoiceRegistration,
} from '@/lib/audio/voice-registration';

describe('voice-registration provider dispatch', () => {
  it('resolves an adapter for a registration-capable provider', () => {
    expect(getVoiceRegistrationAdapter('voxcpm-tts')).toBeDefined();
  });

  it('registers MiniMax reference cloning and account voice listing', () => {
    const adapter = getVoiceRegistrationAdapter('minimax-tts');
    expect(adapter?.supportsRegistration()).toBe(true);
    expect(adapter?.supportsBootstrapReferenceClip).toBe(false);
    expect(adapter?.minReferenceDurationSeconds).toBe(10);
    expect(adapter?.listVoices).toBeTypeOf('function');
  });

  it('returns undefined for providers without an adapter', () => {
    expect(getVoiceRegistrationAdapter('openai-tts')).toBeUndefined();
    expect(supportsVoiceRegistration('openai-tts')).toBe(false);
  });

  it('honors per-provider capability (voxcpm only with the vllm-omni backend)', () => {
    expect(supportsVoiceRegistration('voxcpm-tts', { backend: 'vllm-omni' })).toBe(true);
    expect(supportsVoiceRegistration('voxcpm-tts', { backend: 'nano-vllm' })).toBe(false);
    // default backend (vllm-omni) when unspecified
    expect(supportsVoiceRegistration('voxcpm-tts')).toBe(true);
  });
});
