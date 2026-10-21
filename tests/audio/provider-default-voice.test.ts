import { expect, it } from 'vitest';
import { slotVoice } from '@/lib/server/generation/run/narration-voice';
import { defaultVoiceFor } from '@/lib/audio/tts-selection';

const target = (options?: Record<string, string | number | boolean>) => ({
  providerId: 'openai-tts' as const,
  modelId: 'qwen3-tts',
  connection: {
    providerId: 'openai-tts',
    managed: true,
    userEndpoint: false,
    origin: 'configuration' as const,
    options,
  },
});
it('uses a configured default only when no explicit voice is selected', () => {
  expect(slotVoice(target({ defaultVoice: 'vivian' }), undefined).voice).toBe('vivian');
  expect(
    slotVoice(target({ defaultVoice: 'vivian' }), { providerId: 'openai-tts', voiceId: 'alloy' })
      .voice,
  ).toBe('alloy');
});
it('preserves the original default without the option or with an invalid option', () => {
  const cases: (Record<string, string | number | boolean> | undefined)[] = [
    undefined,
    {},
    { defaultVoice: '' },
    { defaultVoice: true },
  ];
  for (const options of cases) {
    expect(slotVoice(target(options), undefined).voice).toBe('alloy');
  }
});
it('uses the same optional default in the browser', () => {
  expect(defaultVoiceFor('openai-tts', 'qwen3-tts', { defaultVoice: 'vivian' })).toBe('vivian');
  expect(defaultVoiceFor('openai-tts', 'qwen3-tts')).toBe('alloy');
});
