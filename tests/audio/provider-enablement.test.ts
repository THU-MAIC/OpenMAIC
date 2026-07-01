/**
 * Tests for the unified TTS provider-enablement model (#665).
 *
 * Covers the three layered concerns the model collapses:
 *  - availability (configured) — incl. dropping the registry defaultBaseUrl
 *    so a keyless local provider (Lemonade) is NOT force-shown;
 *  - per-provider user `enabled` flag being honored;
 *  - server/admin force-off taking precedence over the user toggle;
 *  - browser-native being opt-in (default OFF) and a first-class provider.
 */
import { describe, it, expect } from 'vitest';
import {
  isTTSProviderConfigured,
  isTTSProviderEnabled,
  listEnabledTTSProviderIds,
  hasAnyEnabledTTSProvider,
  type TTSEnablementConfig,
} from '@/lib/audio/provider-enablement';

describe('isTTSProviderConfigured', () => {
  it('key-requiring provider needs an API key', () => {
    expect(isTTSProviderConfigured('openai-tts', {})).toBe(false);
    expect(isTTSProviderConfigured('openai-tts', { apiKey: '  ' })).toBe(false);
    expect(isTTSProviderConfigured('openai-tts', { apiKey: 'sk-x' })).toBe(true);
    expect(isTTSProviderConfigured('openai-tts', { isServerConfigured: true })).toBe(true);
  });

  it('keyless local provider is NOT shown from the registry defaultBaseUrl alone (Lemonade fix)', () => {
    // lemonade-tts has a registry defaultBaseUrl; with no explicit config it
    // must be unavailable (symptom 1).
    expect(isTTSProviderConfigured('lemonade-tts', {})).toBe(false);
    expect(isTTSProviderConfigured('lemonade-tts', undefined)).toBe(false);
    // Explicit base URL or server config makes it available.
    expect(isTTSProviderConfigured('lemonade-tts', { baseUrl: 'http://localhost:13305/v1' })).toBe(
      true,
    );
    expect(isTTSProviderConfigured('lemonade-tts', { isServerConfigured: true })).toBe(true);
  });

  it('VoxCPM requires an explicit base URL (or server config)', () => {
    expect(isTTSProviderConfigured('voxcpm-tts', {})).toBe(false);
    expect(isTTSProviderConfigured('voxcpm-tts', { baseUrl: 'http://127.0.0.1:8000' })).toBe(true);
  });

  it('browser-native is always configured (runs in-browser)', () => {
    expect(isTTSProviderConfigured('browser-native-tts', undefined)).toBe(true);
    expect(isTTSProviderConfigured('browser-native-tts', {})).toBe(true);
  });

  it('custom provider is configured once it has a credential path or voices', () => {
    expect(isTTSProviderConfigured('custom-tts-foo', {})).toBe(false);
    expect(isTTSProviderConfigured('custom-tts-foo', { apiKey: 'k' })).toBe(true);
    expect(
      isTTSProviderConfigured('custom-tts-foo', { customVoices: [{ id: 'v', name: 'V' }] }),
    ).toBe(true);
  });
});

describe('isTTSProviderEnabled', () => {
  it('honors the per-provider enabled flag (default on)', () => {
    expect(isTTSProviderEnabled('openai-tts', { apiKey: 'k' })).toBe(true);
    expect(isTTSProviderEnabled('openai-tts', { apiKey: 'k', enabled: true })).toBe(true);
    expect(isTTSProviderEnabled('openai-tts', { apiKey: 'k', enabled: false })).toBe(false);
  });

  it('server-disable overrides the user toggle (server precedence)', () => {
    expect(
      isTTSProviderEnabled('openai-tts', { apiKey: 'k', enabled: true, serverDisabled: true }),
    ).toBe(false);
  });

  it('an unconfigured provider is never enabled', () => {
    expect(isTTSProviderEnabled('openai-tts', { enabled: true })).toBe(false);
    expect(isTTSProviderEnabled('lemonade-tts', { enabled: true })).toBe(false);
  });

  it('browser-native is opt-in: default OFF, on only when explicitly enabled', () => {
    // Default persisted config flips browser-native to enabled:false (#665).
    expect(isTTSProviderEnabled('browser-native-tts', { enabled: false })).toBe(false);
    expect(isTTSProviderEnabled('browser-native-tts', { enabled: true })).toBe(true);
    // Server can force it off even when the user enabled it.
    expect(
      isTTSProviderEnabled('browser-native-tts', { enabled: true, serverDisabled: true }),
    ).toBe(false);
  });
});

describe('listEnabledTTSProviderIds / hasAnyEnabledTTSProvider', () => {
  const config: Record<string, TTSEnablementConfig> = {
    'openai-tts': { apiKey: 'k', enabled: true },
    'qwen-tts': { apiKey: 'k', enabled: false }, // configured but user-disabled
    'lemonade-tts': {}, // unconfigured (no explicit baseUrl)
    'voxcpm-tts': { baseUrl: 'http://127.0.0.1:8000', serverDisabled: true }, // server off
    'browser-native-tts': { enabled: false }, // opt-in, off
    'custom-tts-foo': { customVoices: [{ id: 'v', name: 'V' }] },
  };

  it('lists only enabled providers in canonical registry order', () => {
    expect(listEnabledTTSProviderIds(config)).toEqual(['openai-tts', 'custom-tts-foo']);
  });

  it('hasAny reflects emptiness', () => {
    expect(hasAnyEnabledTTSProvider(config)).toBe(true);
    expect(hasAnyEnabledTTSProvider({ 'browser-native-tts': { enabled: false } })).toBe(false);
    expect(hasAnyEnabledTTSProvider({ 'browser-native-tts': { enabled: true } })).toBe(true);
  });
});
