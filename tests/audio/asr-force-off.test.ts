import { describe, expect, it } from 'vitest';
import { ASR_SERVER_DISABLED_MESSAGE, getASRServerDisabledError } from '@/lib/audio/asr-enablement';

describe('ASR client-side force-off guard', () => {
  it('blocks browser-native execution when the server disables the provider', () => {
    expect(getASRServerDisabledError({ serverDisabled: true })).toBe(ASR_SERVER_DISABLED_MESSAGE);
  });

  it('allows providers without a server force-off', () => {
    expect(getASRServerDisabledError()).toBeUndefined();
    expect(getASRServerDisabledError({ serverDisabled: false })).toBeUndefined();
  });
});
