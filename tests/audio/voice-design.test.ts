import { describe, it, expect } from 'vitest';
import {
  buildVoiceDesignPrompt,
  normalizeVoiceDesign,
  getDeterministicVoiceId,
  type VoiceDesign,
} from '@/lib/audio/voice-design';

const design: VoiceDesign = {
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

describe('getDeterministicVoiceId', () => {
  it('is stable for the same descriptor+provider+language+model, with the neutral prefix', async () => {
    const opts = { providerId: 'voxcpm-tts', language: 'zh', model: 'VoxCPM2' };
    const a = await getDeterministicVoiceId(design, opts);
    const b = await getDeterministicVoiceId(design, opts);
    expect(a).toBe(b);
    expect(a).toMatch(/^auto-[0-9a-f]{16}$/);
  });
  it('changes when descriptor, language, model, or provider changes', async () => {
    const base = await getDeterministicVoiceId(design, {
      providerId: 'voxcpm-tts',
      language: 'zh',
      model: 'm',
    });
    const lang = await getDeterministicVoiceId(design, {
      providerId: 'voxcpm-tts',
      language: 'en',
      model: 'm',
    });
    const tex = await getDeterministicVoiceId(
      { ...design, texture: 'bright' },
      { providerId: 'voxcpm-tts', language: 'zh', model: 'm' },
    );
    const prov = await getDeterministicVoiceId(design, {
      providerId: 'elevenlabs-tts',
      language: 'zh',
      model: 'm',
    });
    expect(lang).not.toBe(base);
    expect(tex).not.toBe(base);
    expect(prov).not.toBe(base);
  });
});
