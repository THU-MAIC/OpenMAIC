/**
 * The settings view carries the target saved Qwen clones must match (#2030),
 * so voice settings can mark a voice cloned for another target before anyone
 * plays it, by the same rule the server enforces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { qwenVoiceNeedsReclone } from '@/lib/audio/constants';
import { assertQwenVoiceTarget } from '@/lib/audio/qwen-voice-clone';
import { getVoiceRegistrationAdapter } from '@/lib/audio/voice-registration';

const runtime = await import('@/lib/server/model-config/runtime');
const { modelSettingsView } = await import('@/lib/server/model-config/settings');

type Config = import('@/lib/server/model-config/openmaic-yml').ModelConfigFile;

const config: Config = {
  providers: {
    speech: { preset: 'qwen-tts', apiKey: 'server-key', models: ['qwen3-tts-flash'] },
    vox: { preset: 'voxcpm-tts', baseUrl: 'https://voxcpm.test' },
  },
  slots: { tts: 'speech' },
};

beforeEach(() => {
  runtime.setDeploymentConfigForTests({
    layer: { source: 'deployment', config },
    legacy: false,
    notices: [],
  });
});

afterEach(() => {
  runtime.setDeploymentConfigForTests();
  vi.unstubAllEnvs();
});

const provider = (id: string) => modelSettingsView(null).providers.find((p) => p.id === id)!;

describe('the clone target in the settings view', () => {
  it('is the default CosyVoice target unless the operator overrides it', () => {
    vi.stubEnv('TTS_QWEN_VOICE_CLONE_MODEL', '');
    expect(provider('speech').cloneTarget).toBe('cosyvoice-v3.5-plus');
    vi.stubEnv('TTS_QWEN_VOICE_CLONE_MODEL', ' cosyvoice-v3-plus ');
    expect(provider('speech').cloneTarget).toBe('cosyvoice-v3-plus');
  });

  it('is the target the voice-registration adapter enrolls for', () => {
    vi.stubEnv('TTS_QWEN_VOICE_CLONE_MODEL', 'cosyvoice-v3-plus');
    const adapter = getVoiceRegistrationAdapter('qwen-tts')!;
    expect(provider('speech').cloneTarget).toBe(adapter.resolveRegistrationModel());
  });

  it('is absent for a speech service that does not bind saved voices to a target', () => {
    expect(provider('vox')).not.toHaveProperty('cloneTarget');
  });
});

describe('the re-clone rule settings share with the server', () => {
  it.each([
    ['cosyvoice-v3.5-plus-teacher', 'cosyvoice-v3.5-plus', false],
    ['cosyvoice-v3-plus-teacher', 'cosyvoice-v3.5-plus', true],
    ['cosyvoice-v3.5-plus-teacher', 'cosyvoice-v3-plus', true],
    ['qwen3-tts-vc-2026-01-22-teacher', 'cosyvoice-v3.5-plus', true],
    // Only a CosyVoice target binds clone IDs; any other override rejects none.
    ['cosyvoice-v3-plus-teacher', 'qwen3-tts-vc-operator-model', false],
  ])('%s against %s needs a re-clone: %s', (voiceId, target, expected) => {
    expect(qwenVoiceNeedsReclone(voiceId, target)).toBe(expected);
    const check = () => assertQwenVoiceTarget(voiceId, target);
    if (expected)
      expect(check).toThrow(expect.objectContaining({ code: 'QWEN_VC_RECLONE_REQUIRED' }));
    else expect(check).not.toThrow();
  });
});
