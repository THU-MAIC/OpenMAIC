import { describe, expect, it } from 'vitest';
import { audioFailureKind } from '@/lib/audio/provider-error';
import { QwenVoiceCloneError } from '@/lib/audio/qwen-voice-clone';

describe('audio failure semantics', () => {
  it.each([
    ['QWEN_VC_RECLONE_REQUIRED', 'voice-incompatible'],
    ['QWEN_VC_TIMEOUT', 'timeout'],
    ['QWEN_VC_VOICE_NOT_FOUND', undefined],
    ['QWEN_VC_HTTP_ERROR', undefined],
    ['QWEN_VC_VOICE_PROCESSING', undefined],
    ['QWEN_VC_TRANSPORT_ERROR', undefined],
  ] as const)('maps only the intended semantics for %s', (code, kind) => {
    const error = new QwenVoiceCloneError(code, 409, 'native-code');
    expect(audioFailureKind(error)).toBe(kind);
    expect(error).toBeInstanceOf(QwenVoiceCloneError);
    expect(error).toMatchObject({
      code,
      httpStatus: 409,
      vendorCode: 'native-code',
      name: 'QwenVoiceCloneError',
      message: code,
    });
  });
  it('does not trust incidental error properties as adapter metadata', () => {
    expect(audioFailureKind({ audioFailureKind: 'voice-incompatible' })).toBeUndefined();
  });
});
