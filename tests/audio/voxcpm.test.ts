import { describe, it, expect } from 'vitest';
import {
  buildAutoVoxCPMVoicePrompt,
  voxCPMBackendSupportsVoiceRegistration,
} from '@/lib/audio/voxcpm';
import { buildVoiceDesignPrompt, type VoiceDesign } from '@/lib/audio/voice-design';

const design: VoiceDesign = {
  identity: 'middle-aged male teacher',
  texture: 'warm low-pitched resonant',
  delivery: 'calm measured encouraging',
};

describe('buildAutoVoxCPMVoicePrompt fallback chain', () => {
  it('prefers voiceDesign over persona', () => {
    expect(buildAutoVoxCPMVoicePrompt({ voiceDesign: design, persona: 'loves cats' })).toBe(
      buildVoiceDesignPrompt(design),
    );
  });
  it('falls back to persona, then role/name, then default', () => {
    expect(buildAutoVoxCPMVoicePrompt({ persona: 'patient mentor' })).toBe('patient mentor');
    expect(buildAutoVoxCPMVoicePrompt({ role: 'teacher', agentName: 'Lin' })).toBe('teacher Lin');
    expect(buildAutoVoxCPMVoicePrompt({})).toBe('natural classroom voice');
  });
});

describe('voxCPMBackendSupportsVoiceRegistration', () => {
  it('is true only for vllm-omni', () => {
    expect(voxCPMBackendSupportsVoiceRegistration('vllm-omni')).toBe(true);
    expect(voxCPMBackendSupportsVoiceRegistration('nano-vllm')).toBe(false);
    expect(voxCPMBackendSupportsVoiceRegistration('python-api')).toBe(false);
  });
});
