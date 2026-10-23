import { describe, expect, it } from 'vitest';
import { voiceCloneRecoveryReason } from '@/lib/audio/voice-clone-recovery';

describe('voice clone playback recovery', () => {
  it.each(['errorCode', 'code'] as const)(
    'recognizes browser and server %s without changing the error',
    (field) => {
      const error = { [field]: 'QWEN_VC_RECLONE_REQUIRED' };
      expect(voiceCloneRecoveryReason(error)).toBe('reclone-required');
      expect(error[field]).toBe('QWEN_VC_RECLONE_REQUIRED');
      expect(voiceCloneRecoveryReason({ [field]: 'QWEN_VC_VOICE_NOT_FOUND' })).toBe('missing');
    },
  );

  it.each([
    undefined,
    null,
    'QWEN_VC_RECLONE_REQUIRED',
    {},
    { code: 'QWEN_VC_CONFIG_MISSING' },
    { errorCode: 'QWEN_VC_REFERENCE_AUDIO_INVALID' },
    new Error('QWEN_VC_RECLONE_REQUIRED'),
  ])('does not recover unrelated errors: %j', (error) => {
    expect(voiceCloneRecoveryReason(error)).toBeUndefined();
  });
});
