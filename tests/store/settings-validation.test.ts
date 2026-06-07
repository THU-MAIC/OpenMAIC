import { describe, it, expect } from 'vitest';
import {
  isProviderUsable,
  validateProvider,
  validateModel,
  resolveSelectedModel,
  hasUsableLLMProvider,
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

  it('returns true for keyless provider with explicit baseUrl', () => {
    expect(isProviderUsable({ requiresApiKey: false, baseUrl: 'http://localhost:11434/v1' })).toBe(
      true,
    );
  });

  it('returns false for keyless provider without baseUrl', () => {
    expect(isProviderUsable({ requiresApiKey: false })).toBe(false);
  });

  it('returns false for keyless provider with empty baseUrl', () => {
    expect(isProviderUsable({ requiresApiKey: false, baseUrl: '' })).toBe(false);
  });

  it('returns true for keyless provider when server-configured', () => {
    expect(isProviderUsable({ requiresApiKey: false, isServerConfigured: true })).toBe(true);
  });

  it('returns false for keyless provider with apiKey but no baseUrl', () => {
    expect(isProviderUsable({ requiresApiKey: false, apiKey: 'some-key' })).toBe(false);
  });

  it('returns false for a server-disabled provider even with a client API key (#665)', () => {
    expect(isProviderUsable({ apiKey: 'sk-xxx', serverDisabled: true })).toBe(false);
    expect(isProviderUsable({ isServerConfigured: true, serverDisabled: true })).toBe(false);
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

  it('re-points away from a server-disabled current provider that has a client key (#665)', () => {
    const configMap = {
      'provider-a': cfg({ apiKey: 'sk-xxx', serverDisabled: true }),
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

describe('resolveSelectedModel', () => {
  it('keeps model when still in available list', () => {
    expect(resolveSelectedModel('gpt-4o', [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }])).toBe(
      'gpt-4o',
    );
  });

  it('falls back to first model when current is not in list', () => {
    expect(resolveSelectedModel('gpt-4-turbo', [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }])).toBe(
      'gpt-4o',
    );
  });

  it('falls back to first model when current is empty (the invariant: usable provider ⇒ concrete model)', () => {
    expect(resolveSelectedModel('', [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }])).toBe('gpt-4o');
  });

  it('returns empty string only when the model list is empty', () => {
    expect(resolveSelectedModel('gpt-4o', [])).toBe('');
    expect(resolveSelectedModel('', [])).toBe('');
  });

  it('never yields empty when the provider has at least one model', () => {
    for (const current of ['', 'unknown', 'glm-4']) {
      expect(resolveSelectedModel(current, [{ id: 'glm-4' }])).not.toBe('');
    }
  });
});

describe('hasUsableLLMProvider', () => {
  const ok = { apiKey: 'sk-x', models: [{ id: 'm1' }], defaultBaseUrl: 'https://x' };

  it('returns true when a provider has credentials, ≥1 model, and an endpoint', () => {
    expect(hasUsableLLMProvider({ openai: ok })).toBe(true);
  });

  it('returns true for a server-configured provider without a client key', () => {
    expect(
      hasUsableLLMProvider({
        openai: { isServerConfigured: true, models: [{ id: 'm1' }] },
      }),
    ).toBe(true);
  });

  it('returns false when the only provider has no models', () => {
    expect(hasUsableLLMProvider({ openai: { ...ok, models: [] } })).toBe(false);
  });

  it('returns false when the only provider lacks credentials and requires a key', () => {
    expect(
      hasUsableLLMProvider({
        openai: { requiresApiKey: true, apiKey: '', models: [{ id: 'm1' }], defaultBaseUrl: 'x' },
      }),
    ).toBe(false);
  });

  it('returns false for an empty or nullish config', () => {
    expect(hasUsableLLMProvider({})).toBe(false);
    expect(hasUsableLLMProvider(undefined)).toBe(false);
    expect(hasUsableLLMProvider(null)).toBe(false);
  });

  it('treats a keyless provider with only a registry defaultBaseUrl as NOT configured', () => {
    // ollama/lemonade ship requiresApiKey:false + a defaultBaseUrl but an
    // empty user baseUrl by default — must NOT count as usable, otherwise
    // the page gate is true while reconcile never selects it (#580 keyless).
    expect(
      hasUsableLLMProvider({
        ollama: {
          requiresApiKey: false,
          apiKey: '',
          baseUrl: '',
          models: [{ id: 'llama3.3' }],
          defaultBaseUrl: 'http://localhost:11434/v1',
        },
      }),
    ).toBe(false);
  });

  it('treats a keyless provider as configured once the user sets an explicit baseUrl', () => {
    expect(
      hasUsableLLMProvider({
        ollama: {
          requiresApiKey: false,
          apiKey: '',
          baseUrl: 'http://my-ollama:11434/v1',
          models: [{ id: 'llama3.3' }],
          defaultBaseUrl: 'http://localhost:11434/v1',
        },
      }),
    ).toBe(true);
  });

  it('treats a keyless provider as configured when server-configured', () => {
    expect(
      hasUsableLLMProvider({
        ollama: {
          requiresApiKey: false,
          apiKey: '',
          baseUrl: '',
          isServerConfigured: true,
          models: [{ id: 'llama3.3' }],
        },
      }),
    ).toBe(true);
  });
});
