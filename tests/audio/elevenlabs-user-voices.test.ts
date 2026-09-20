/**
 * ElevenLabs voices the user supplied (pasted by hand, or imported from the
 * account via /api/elevenlabs-voices) must behave like first-class voices.
 *
 * The built-in ElevenLabs list is a six-voice English-only starter set, so a
 * deployment that needs a voice in another language can only get there through
 * its own ids. Three separate consumers read that list, and a miss in any one
 * of them is silent: the voice is visible somewhere but unselectable, and the
 * narrator quietly stays on a built-in preset.
 */
import { describe, it, expect } from 'vitest';
import {
  dedupeVoicesById,
  getConfiguredUserVoices,
  getEnabledProvidersWithVoices,
  getServerVoiceList,
  findVoiceDisplayName,
} from '@/lib/audio/voice-resolver';
import { providerAcceptsUserVoices } from '@/lib/audio/types';
import { TTS_PROVIDERS } from '@/lib/audio/constants';

const VN_VOICE = { id: 'vn-voice-id', name: 'Giọng Việt' };
const config = {
  'elevenlabs-tts': { apiKey: 'k', enabled: true, customVoices: [VN_VOICE] },
};

describe('providerAcceptsUserVoices', () => {
  it('accepts ElevenLabs and custom providers, refuses other built-ins', () => {
    expect(providerAcceptsUserVoices('elevenlabs-tts')).toBe(true);
    expect(providerAcceptsUserVoices('custom-tts-abc')).toBe(true);
    expect(providerAcceptsUserVoices('openai-tts')).toBe(false);
  });
});

describe('getConfiguredUserVoices', () => {
  it('returns the ids the user added for an accepting provider', () => {
    expect(getConfiguredUserVoices('elevenlabs-tts', config)).toEqual([
      { id: VN_VOICE.id, name: VN_VOICE.name, language: 'auto' },
    ]);
  });

  it('returns nothing for a provider that does not accept user voices', () => {
    expect(
      getConfiguredUserVoices('openai-tts', {
        'openai-tts': { customVoices: [VN_VOICE] },
      }),
    ).toEqual([]);
  });
});

describe('getServerVoiceList', () => {
  it('appends user voices to the built-in ElevenLabs catalogue', () => {
    const list = getServerVoiceList('elevenlabs-tts', config);
    expect(list).toContain(VN_VOICE.id);
    for (const builtIn of TTS_PROVIDERS['elevenlabs-tts'].voices) {
      expect(list).toContain(builtIn.id);
    }
  });
});

describe('getEnabledProvidersWithVoices', () => {
  const entry = () =>
    getEnabledProvidersWithVoices(config).find((p) => p.providerId === 'elevenlabs-tts');

  it('offers the user voice alongside the presets', () => {
    expect(entry()?.voices.map((v) => v.id)).toContain(VN_VOICE.id);
  });

  it('offers it under every model group, so picking a model cannot hide it', () => {
    const groups = entry()?.modelGroups ?? [];
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group.voices.map((v) => v.id)).toContain(VN_VOICE.id);
    }
  });

  it('lists a voice once when an import repeats a built-in id', () => {
    const preset = TTS_PROVIDERS['elevenlabs-tts'].voices[0];
    const withDuplicate = getEnabledProvidersWithVoices({
      'elevenlabs-tts': {
        apiKey: 'k',
        enabled: true,
        customVoices: [{ id: preset.id, name: preset.name }],
      },
    }).find((p) => p.providerId === 'elevenlabs-tts');
    const occurrences = withDuplicate?.voices.filter((v) => v.id === preset.id).length;
    expect(occurrences).toBe(1);
  });
});

describe('findVoiceDisplayName', () => {
  it('names a user-added ElevenLabs voice', () => {
    expect(findVoiceDisplayName('elevenlabs-tts', VN_VOICE.id, config)).toBe(VN_VOICE.name);
  });

  it('still falls back to the built-in catalogue for a preset id', () => {
    const preset = TTS_PROVIDERS['elevenlabs-tts'].voices[0];
    expect(findVoiceDisplayName('elevenlabs-tts', preset.id, config)).toBe(preset.name);
  });
});

describe('dedupeVoicesById', () => {
  it('keeps the first entry for a repeated id', () => {
    expect(dedupeVoicesById([{ id: 'a', n: 1 }, { id: 'b' }, { id: 'a', n: 2 }])).toEqual([
      { id: 'a', n: 1 },
      { id: 'b' },
    ]);
  });
});
