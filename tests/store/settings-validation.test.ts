import { describe, it, expect } from 'vitest';
import {
  isProviderUsable,
  validateProvider,
  validateModel,
  type ProviderCfgLike,
} from '@/lib/store/settings-validation';

describe('isProviderUsable', () => {
  it('returns true when provider has client API key', () => {
    expect(isProviderUsable({ apiKey: 'sk-xxx' })).toBe(true);
  });

  it('returns true when provider is server-configured', () => {
    expect(isProviderUsable({ isServerConfigured: true })).toBe(true);
  });

  it('returns true when provider has both client key and server config', () => {
    expect(isProviderUsable({ apiKey: 'sk-xxx', isServerConfigured: true })).toBe(true);
  });

  it('returns false when has neither client key nor server config', () => {
    expect(isProviderUsable({ apiKey: '', isServerConfigured: false })).toBe(false);
  });

  it('returns false when apiKey is empty and not server-configured', () => {
    expect(isProviderUsable({ apiKey: '' })).toBe(false);
  });

  it('returns false for undefined config', () => {
    expect(isProviderUsable(undefined)).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(isProviderUsable({})).toBe(false);
  });
});

describe('validateProvider', () => {
  const cfg = (overrides: Partial<ProviderCfgLike> = {}): ProviderCfgLike => ({
    apiKey: '',
    isServerConfigured: false,
    ...overrides,
  });

  it('keeps current provider when it is server-configured', () => {
    const configMap = {
      'provider-a': cfg({ isServerConfigured: true }),
      'provider-b': cfg(),
    };
    expect(validateProvider('provider-a', configMap, ['provider-b'])).toBe('provider-a');
  });

  it('keeps current provider when it has client API key', () => {
    const configMap = {
      'provider-a': cfg({ apiKey: 'sk-xxx' }),
      'provider-b': cfg(),
    };
    expect(validateProvider('provider-a', configMap, ['provider-b'])).toBe('provider-a');
  });

  it('falls back to first usable provider when current is unusable', () => {
    const configMap = {
      'provider-a': cfg(),
      'provider-b': cfg({ isServerConfigured: true }),
    };
    expect(validateProvider('provider-a', configMap, ['provider-b'])).toBe('provider-b');
  });

  it('returns empty string when no fallback is usable and no default', () => {
    const configMap = {
      'provider-a': cfg(),
      'provider-b': cfg(),
    };
    expect(validateProvider('provider-a', configMap, ['provider-b'])).toBe('');
  });

  it('falls back to defaultId when no fallback is usable', () => {
    const configMap = {
      'provider-a': cfg(),
      'provider-b': cfg(),
    };
    expect(validateProvider('provider-a', configMap, ['provider-b'], 'browser-native')).toBe(
      'browser-native',
    );
  });

  it('prefers usable fallback over defaultId', () => {
    const configMap = {
      'provider-a': cfg(),
      'provider-b': cfg({ isServerConfigured: true }),
    };
    expect(validateProvider('provider-a', configMap, ['provider-b'], 'browser-native')).toBe(
      'provider-b',
    );
  });

  it('returns current id unchanged when it is empty', () => {
    const configMap = { 'provider-a': cfg({ isServerConfigured: true }) };
    expect(validateProvider('', configMap, ['provider-a'])).toBe('');
  });
});

describe('validateModel', () => {
  it('keeps model when still in available list', () => {
    expect(validateModel('gpt-4o', [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }])).toBe('gpt-4o');
  });

  it('falls back to first model when current is not in list', () => {
    expect(validateModel('gpt-4-turbo', [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }])).toBe('gpt-4o');
  });

  it('returns empty string when list is empty', () => {
    expect(validateModel('gpt-4o', [])).toBe('');
  });

  it('returns current id unchanged when it is empty', () => {
    expect(validateModel('', [{ id: 'gpt-4o' }])).toBe('');
  });
});
