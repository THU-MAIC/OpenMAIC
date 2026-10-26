import { describe, expect, it } from 'vitest';
import { voiceAfterUnavailableBinding } from '@/lib/audio/voice-resolver';

describe('unavailable binding fallback', () => {
  it('skips a disabled global provider and chooses a different enabled voice', () => {
    expect(
      voiceAfterUnavailableBinding(
        { providerId: 'qwen-tts', voiceId: 'clone-retired' },
        { providerId: 'openai-tts', voiceId: 'alloy' },
        { 'openai-tts': { enabled: false }, 'qwen-tts': { apiKey: 'test', enabled: true } },
      ),
    ).toMatchObject({ providerId: 'qwen-tts', voiceId: 'Cherry' });
  });
  it('skips another unknown Qwen clone for a reclone-required recovery', () => {
    expect(
      voiceAfterUnavailableBinding(
        { providerId: 'qwen-tts', voiceId: 'old-clone-a' },
        { providerId: 'qwen-tts', voiceId: 'old-clone-b' },
        { 'qwen-tts': { apiKey: 'test', enabled: true, modelId: 'qwen3-tts-flash' } },
        'reclone-required',
      ),
    ).toMatchObject({ providerId: 'qwen-tts', voiceId: 'Cherry' });
  });
  it.each([
    ['cosyvoice-v3.5-plus-new-id', 'qwen3-tts-vc-2026-01-22'],
    ['cosyvoice-v3-flash-new-id', 'cosyvoice-v3-flash'],
    ['cosyvoice-v3.5-plus-new-id', 'qwen3-tts'],
    ['operator-target-new-id', 'operator-target'],
  ])('tries the newly selected global clone %s before catalog fallback', (voiceId, modelId) => {
    expect(
      voiceAfterUnavailableBinding(
        { providerId: 'qwen-tts', voiceId: 'qwen-tts-vc-old-id' },
        { providerId: 'qwen-tts', voiceId, modelId },
        { 'qwen-tts': { apiKey: 'test', enabled: true } },
        'reclone-required',
      ),
    ).toMatchObject({ voiceId });
  });
  it('ignores the legacy catalog model hint on the provider configuration', () => {
    expect(
      voiceAfterUnavailableBinding(
        { providerId: 'qwen-tts', voiceId: 'qwen-tts-vc-old-id' },
        { providerId: 'qwen-tts', voiceId: 'cosyvoice-v3.5-plus-new-id' },
        { 'qwen-tts': { apiKey: 'test', enabled: true, modelId: 'qwen3-tts' } },
        'reclone-required',
      ),
    ).toMatchObject({ voiceId: 'cosyvoice-v3.5-plus-new-id' });
  });
  it.each([
    ['cosyvoice-v3-plus-other-id', 'cosyvoice-v3-flash'],
    ['qwen3-tts-flash-opaque', 'qwen3-tts-flash'],
    ['cosyvoice-v3-plus-new-id', 'operator-target'],
    ['qwen-tts-vc-retired-id', 'qwen-tts-vc-retired'],
  ])('does not treat %s as a compatible global clone for %s', (voiceId, modelId) => {
    expect(
      voiceAfterUnavailableBinding(
        { providerId: 'qwen-tts', voiceId: 'old-a' },
        { providerId: 'qwen-tts', voiceId, modelId },
        { 'qwen-tts': { apiKey: 'test', enabled: true } },
        'reclone-required',
      ),
    ).toMatchObject({ voiceId: 'Cherry' });
  });
  it('keeps an explicitly configured catalog voice even if its name resembles a clone', () => {
    expect(
      voiceAfterUnavailableBinding(
        { providerId: 'qwen-tts', voiceId: 'old-clone-a' },
        { providerId: 'qwen-tts', voiceId: 'operator-voice' },
        {
          'qwen-tts': {
            apiKey: 'test',
            enabled: true,
            modelId: 'operator-model',
            voices: [{ id: 'operator-voice', name: 'Operator' }],
          },
        },
        'reclone-required',
      ),
    ).toMatchObject({ providerId: 'qwen-tts', voiceId: 'operator-voice' });
  });
  it('honors a replacement catalogue when the global preset is no longer listed', () => {
    expect(
      voiceAfterUnavailableBinding(
        { providerId: 'qwen-tts', voiceId: 'old-a' },
        { providerId: 'qwen-tts', voiceId: 'Cherry' },
        { 'qwen-tts': { apiKey: 'test', voices: [{ id: 'operator-voice', name: 'Operator' }] } },
        'reclone-required',
      ),
    ).toMatchObject({ voiceId: 'operator-voice' });
  });
  it('preserves the single global-clone attempt for a missing voice', () => {
    expect(
      voiceAfterUnavailableBinding(
        { providerId: 'qwen-tts', voiceId: 'missing-a' },
        { providerId: 'qwen-tts', voiceId: 'missing-b' },
        { 'qwen-tts': { apiKey: 'test', enabled: true } },
        'missing',
      ),
    ).toMatchObject({ voiceId: 'missing-b' });
  });
  it('returns no candidate when the only provider is disabled', () => {
    expect(
      voiceAfterUnavailableBinding(
        { providerId: 'qwen-tts', voiceId: 'old-a' },
        { providerId: 'qwen-tts', voiceId: 'old-b' },
        { 'qwen-tts': { apiKey: 'test', enabled: false, modelId: 'operator-clone-target' } },
        'reclone-required',
      ),
    ).toBeNull();
  });
  it('skips catalog voices incompatible with the enabled model', () => {
    expect(
      voiceAfterUnavailableBinding(
        { providerId: 'qwen-tts', voiceId: 'old-a' },
        { providerId: 'qwen-tts', voiceId: 'old-b' },
        { 'openai-tts': { apiKey: 'test', enabled: true, modelId: 'tts-1' } },
        'reclone-required',
      ),
    ).toMatchObject({ providerId: 'openai-tts', voiceId: 'alloy' });
  });
  it('returns no retry when no provider is enabled', () => {
    expect(
      voiceAfterUnavailableBinding(
        { providerId: 'qwen-tts', voiceId: 'clone-retired' },
        { providerId: 'qwen-tts', voiceId: 'clone-retired' },
        {},
      ),
    ).toBeNull();
  });
});
