import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearUnavailableVoiceBindingsForTests,
  clearVoiceBindingUnavailable,
  isVoiceBindingUnavailable,
  markVoiceBindingUnavailable,
  markVoiceBindingNoticeShown,
  trackAssignedVoiceBinding,
  voiceBindingKey,
} from '@/lib/audio/unavailable-voice-bindings';

describe('unavailable voice bindings', () => {
  beforeEach(clearUnavailableVoiceBindingsForTests);

  it('keys failures by provider and voice rather than agent identity', () => {
    markVoiceBindingUnavailable({ providerId: 'qwen-tts', voiceId: 'clone-a' });
    expect(isVoiceBindingUnavailable({ providerId: 'qwen-tts', voiceId: 'clone-a' })).toBe(true);
    expect(isVoiceBindingUnavailable({ providerId: 'qwen-tts', voiceId: 'clone-b' })).toBe(false);
  });

  it('keeps the old failure and toast dedup when an agent changes its assigned binding', () => {
    const oldBinding = { providerId: 'qwen-tts', voiceId: 'clone-a' };
    const oldKey = markVoiceBindingUnavailable(oldBinding);
    expect(markVoiceBindingNoticeShown(oldKey)).toBe(true);
    const nextKey = trackAssignedVoiceBinding(voiceBindingKey(oldBinding), {
      providerId: 'qwen-tts',
      voiceId: 'clone-b',
    });
    expect(nextKey).toBe(voiceBindingKey({ providerId: 'qwen-tts', voiceId: 'clone-b' }));
    expect(isVoiceBindingUnavailable(oldBinding)).toBe(true);
    expect(markVoiceBindingNoticeShown(oldKey)).toBe(false);
  });

  it('allows successful re-registration to unblock the same provider voice id', () => {
    const binding = { providerId: 'qwen-tts', voiceId: 'clone-a' };
    markVoiceBindingUnavailable(binding);
    clearVoiceBindingUnavailable(binding);
    expect(isVoiceBindingUnavailable(binding)).toBe(false);
  });
});
