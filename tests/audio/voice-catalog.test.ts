/**
 * Provider-neutral voice catalog merge — the single implementation the agent's
 * `list_voices` tool and `set_roster`'s binding validation share.
 *
 * These tests pin the merge contract so the two sources (presets / registered
 * voices) and the clone capability bits (`supportsClone` /
 * `requiresRegisteredVoice`) cannot silently drop out:
 *   - dropping either source reddens "merges presets AND registered voices";
 *   - ignoring `supportsClone` or `requiresRegisteredVoice` reddens the
 *     clone-visibility tests.
 */
import { describe, expect, it } from 'vitest';

import { TTS_PROVIDERS } from '@/lib/audio/constants';
import type { BuiltInTTSProviderId, TTSProviderConfig } from '@/lib/audio/types';
import {
  buildVoiceCatalog,
  type RegisteredVoiceInfo,
  type VoiceCatalogProvider,
} from '@/lib/audio/voice-catalog';

function provider(
  id: BuiltInTTSProviderId,
  overrides: Partial<TTSProviderConfig> = {},
): TTSProviderConfig {
  return { ...TTS_PROVIDERS[id], ...overrides };
}

describe('buildVoiceCatalog — presets + registered merge', () => {
  const presetProvider = provider('doubao-tts');
  const presetBindings = presetProvider.voices.map((voice) => `doubao-tts::${voice.id}`);
  const registered: RegisteredVoiceInfo[] = [
    { providerId: 'doubao-tts', voiceId: 'v9', name: 'Registered V9', kind: 'prompt' },
  ];

  it('emits every preset as a bindable providerId::voiceId entry', () => {
    const catalog = buildVoiceCatalog([presetProvider]);
    expect(catalog.map((voice) => voice.binding)).toEqual(presetBindings);
    expect(catalog[0]).toMatchObject({
      providerId: 'doubao-tts',
      id: presetProvider.voices[0]!.id,
      name: presetProvider.voices[0]!.name,
      language: presetProvider.voices[0]!.language,
      gender: presetProvider.voices[0]!.gender,
      binding: presetBindings[0],
    });
  });

  // Fault injection: dropping either source must redden this test.
  it('merges registered voices with presets (presets first, then registered)', () => {
    const catalog = buildVoiceCatalog([presetProvider], registered);
    expect(catalog.map((voice) => voice.binding)).toEqual([...presetBindings, 'doubao-tts::v9']);
    expect(catalog.at(-1)).toMatchObject({
      binding: 'doubao-tts::v9',
      name: 'Registered V9',
      language: 'auto',
    });
  });

  it('skips registered voices whose provider is not in the enabled set', () => {
    const catalog = buildVoiceCatalog(
      [presetProvider],
      [{ providerId: 'glm-tts', voiceId: 'tongtong', name: 'Tongtong', kind: 'prompt' }],
    );
    expect(catalog.map((voice) => voice.binding)).not.toContain('glm-tts::tongtong');
    expect(catalog.map((voice) => voice.binding)).toEqual(presetBindings);
  });
});

describe('buildVoiceCatalog — clone capability bits', () => {
  const voxcpm = provider('voxcpm-tts');
  const voxcpmPresetBindings = voxcpm.voices.map((voice) => `voxcpm-tts::${voice.id}`);
  const clones: RegisteredVoiceInfo[] = [
    { providerId: 'voxcpm-tts', voiceId: 'p1', name: 'Prompt Voice', kind: 'prompt' },
    { providerId: 'voxcpm-tts', voiceId: 'p2', name: 'Clone Voice', kind: 'clone' },
  ];

  // Fault injection: ignoring `supportsClone` reddens this test.
  it('hides clone voices unless supportsClone is set (capability, not id)', () => {
    const hidden = buildVoiceCatalog([voxcpm], clones, { supportsClone: false });
    expect(hidden.map((voice) => voice.binding)).toEqual([
      ...voxcpmPresetBindings,
      'voxcpm-tts::p1',
    ]);

    const shown = buildVoiceCatalog([voxcpm], clones, { supportsClone: true });
    expect(shown.map((voice) => voice.binding)).toEqual([
      ...voxcpmPresetBindings,
      'voxcpm-tts::p1',
      'voxcpm-tts::p2',
    ]);
  });

  // Fault injection: ignoring `requiresRegisteredVoice` reddens this test. A
  // clone-only provider (no deployment default voice) must offer its registered
  // voices even when clone synthesis is unavailable — they are the only voices
  // that provider can produce.
  it('keeps registered voices of a requiresRegisteredVoice provider visible regardless of supportsClone', () => {
    const cloneOnly: VoiceCatalogProvider = {
      id: 'clone-only-tts',
      voices: [],
      requiresRegisteredVoice: true,
    };
    const catalog = buildVoiceCatalog(
      [cloneOnly],
      [{ providerId: 'clone-only-tts', voiceId: 'enda', name: 'Enda', kind: 'clone' }],
      { supportsClone: false },
    );
    expect(catalog.map((voice) => voice.binding)).toEqual(['clone-only-tts::enda']);
  });

  it('carries gender and description through on registered voices when present', () => {
    const catalog = buildVoiceCatalog(
      [voxcpm],
      [
        {
          providerId: 'voxcpm-tts',
          voiceId: 'v9',
          name: 'V9',
          gender: 'female',
          description: 'registered clone',
          kind: 'clone',
        },
      ],
      { supportsClone: true },
    );
    expect(catalog.at(-1)).toMatchObject({
      binding: 'voxcpm-tts::v9',
      name: 'V9',
      language: 'auto',
      gender: 'female',
      description: 'registered clone',
    });
  });
});
