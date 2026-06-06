import { describe, it, expect } from 'vitest';
import {
  buildAutoVoxCPMVoicePrompt,
  buildVoiceDesignPrompt,
  normalizeVoiceDesign,
  voxCPMBackendSupportsVoiceRegistration,
  getDeterministicVoxCPMVoiceId,
  type VoxCPMVoiceDesign,
} from '@/lib/audio/voxcpm';

const design: VoxCPMVoiceDesign = {
  identity: 'middle-aged male teacher',
  texture: 'warm low-pitched resonant',
  delivery: 'calm measured encouraging',
};

describe('buildVoiceDesignPrompt', () => {
  it('composes the three layers into one comma-joined prompt', () => {
    expect(buildVoiceDesignPrompt(design)).toBe(
      'middle-aged male teacher, warm low-pitched resonant, calm measured encouraging',
    );
  });
  it('drops blank layers and collapses whitespace', () => {
    expect(
      buildVoiceDesignPrompt({ identity: '  male  teacher ', texture: '', delivery: 'slow' }),
    ).toBe('male teacher, slow');
  });
});

describe('normalizeVoiceDesign', () => {
  it('returns a clean design from a well-formed object', () => {
    expect(normalizeVoiceDesign({ identity: 'a', texture: 'b', delivery: 'c' })).toEqual({
      identity: 'a',
      texture: 'b',
      delivery: 'c',
    });
  });
  it('returns undefined when all layers are empty/missing', () => {
    expect(normalizeVoiceDesign({})).toBeUndefined();
    expect(normalizeVoiceDesign(null)).toBeUndefined();
    expect(normalizeVoiceDesign('nope')).toBeUndefined();
  });
  it('keeps a partial design (some layers present)', () => {
    expect(normalizeVoiceDesign({ identity: 'a' })).toEqual({
      identity: 'a',
      texture: '',
      delivery: '',
    });
  });
});

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

describe('getDeterministicVoxCPMVoiceId', () => {
  it('is stable for the same descriptor+language+model', async () => {
    const a = await getDeterministicVoxCPMVoiceId(design, { language: 'zh', model: 'VoxCPM2' });
    const b = await getDeterministicVoxCPMVoiceId(design, { language: 'zh', model: 'VoxCPM2' });
    expect(a).toBe(b);
    expect(a).toMatch(/^voxcpm:voice:[0-9a-f]{16}$/);
  });
  it('changes when any input changes', async () => {
    const base = await getDeterministicVoxCPMVoiceId(design, { language: 'zh', model: 'VoxCPM2' });
    const lang = await getDeterministicVoxCPMVoiceId(design, { language: 'en', model: 'VoxCPM2' });
    const tex = await getDeterministicVoxCPMVoiceId(
      { ...design, texture: 'bright' },
      { language: 'zh', model: 'VoxCPM2' },
    );
    expect(lang).not.toBe(base);
    expect(tex).not.toBe(base);
  });
});
