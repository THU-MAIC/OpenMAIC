import { describe, expect, it } from 'vitest';
import { getAvailableProvidersWithVoices } from '@/lib/audio/voice-resolver';

describe('getAvailableProvidersWithVoices keyless availability (#574)', () => {
  it('excludes a keyless provider when only defaultBaseUrl exists (no user-configured URL)', () => {
    // lemonade-tts is keyless and ships defaultBaseUrl; with no user config it must not be listed
    const providers = getAvailableProvidersWithVoices({});
    expect(providers.map((p) => p.providerId)).not.toContain('lemonade-tts');
  });

  it('excludes a keyless provider whose config has neither serverBaseUrl nor baseUrl', () => {
    const providers = getAvailableProvidersWithVoices({
      'lemonade-tts': { enabled: true },
    });
    expect(providers.map((p) => p.providerId)).not.toContain('lemonade-tts');
  });

  it('includes a keyless provider when the user sets serverBaseUrl', () => {
    const providers = getAvailableProvidersWithVoices({
      'lemonade-tts': { serverBaseUrl: 'http://localhost:13305/v1' },
    });
    expect(providers.map((p) => p.providerId)).toContain('lemonade-tts');
  });

  it('includes a keyless provider when the user sets baseUrl', () => {
    const providers = getAvailableProvidersWithVoices({
      'lemonade-tts': { baseUrl: 'http://localhost:13305/v1' },
    });
    expect(providers.map((p) => p.providerId)).toContain('lemonade-tts');
  });

  it('ignores whitespace-only URLs for keyless providers', () => {
    const providers = getAvailableProvidersWithVoices({
      'lemonade-tts': { serverBaseUrl: '   ', baseUrl: '' },
    });
    expect(providers.map((p) => p.providerId)).not.toContain('lemonade-tts');
  });

  it('still includes key-based providers via apiKey', () => {
    const providers = getAvailableProvidersWithVoices({
      'openai-tts': { apiKey: 'sk-test' },
    });
    expect(providers.map((p) => p.providerId)).toContain('openai-tts');
  });
});
