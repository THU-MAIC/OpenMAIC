import { describe, expect, it } from 'vitest';

import {
  assertQwenNarratorVoiceTargets,
  QWEN_VOICE_SETTINGS_URL,
  startRefusal,
} from '@/lib/server/generation/run/start';

describe('generation-start narrator voice validation', () => {
  it('refuses an incompatible voice before generation work and names it with a Settings link', () => {
    expect(() =>
      assertQwenNarratorVoiceTargets('cosyvoice-v3.5-plus', [
        { providerId: 'qwen-tts', voiceId: 'qwen-tts-vc-old-id', name: 'Ada' },
      ]),
    ).toThrow('Ada');

    const refusal = startRefusal(
      (() => {
        try {
          assertQwenNarratorVoiceTargets('cosyvoice-v3.5-plus', [
            { providerId: 'qwen-tts', voiceId: 'qwen-tts-vc-old-id', name: 'Ada' },
          ]);
        } catch (error) {
          return error;
        }
        throw new Error('expected voice validation to refuse');
      })(),
    );
    expect(refusal).toMatchObject({
      code: 'QWEN_VC_RECLONE_REQUIRED',
      status: 400,
    });
    expect(refusal?.message).toContain(QWEN_VOICE_SETTINGS_URL);
  });

  it('passes a compatible voice through unchanged', () => {
    const candidate = {
      providerId: 'qwen-tts',
      voiceId: 'cosyvoice-v3.5-plus-new-id',
      name: 'Ada',
    } as const;
    expect(() => assertQwenNarratorVoiceTargets('cosyvoice-v3.5-plus', [candidate])).not.toThrow();
    expect(candidate).toEqual({
      providerId: 'qwen-tts',
      voiceId: 'cosyvoice-v3.5-plus-new-id',
      name: 'Ada',
    });
  });

  it('checks every narrator candidate and refuses an incompatible later voice', () => {
    expect(() =>
      assertQwenNarratorVoiceTargets('cosyvoice-v3.5-plus', [
        { providerId: 'qwen-tts', voiceId: 'cosyvoice-v3.5-plus-first', name: 'Ada' },
        { providerId: 'qwen-tts', voiceId: 'qwen3-tts-vc-old-id', name: 'Bea' },
      ]),
    ).toThrow('Bea');
  });
});
