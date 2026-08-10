/**
 * Claude web-search provider settings: defaults, model selection, and the
 * disable-falls-back-to-default rule (#784) applied to the claude provider.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '@/lib/store/settings';

describe('claude web search settings', () => {
  beforeEach(() => {
    useSettingsStore.setState({ webSearchProviderId: 'tavily' });
  });

  it('includes claude in the default provider config with an empty model', () => {
    const config = useSettingsStore.getState().webSearchProvidersConfig.claude;
    expect(config).toMatchObject({
      apiKey: '',
      baseUrl: '',
      enabled: true,
      requiresApiKey: true,
      modelId: '',
    });
  });

  it('persists the selected search model via setWebSearchProviderConfig', () => {
    const s = useSettingsStore.getState();
    s.setWebSearchProviderConfig('claude', { modelId: 'claude-opus-5' });
    expect(useSettingsStore.getState().webSearchProvidersConfig.claude?.modelId).toBe(
      'claude-opus-5',
    );

    s.setWebSearchProviderConfig('claude', { apiKey: 'sk-test' });
    const config = useSettingsStore.getState().webSearchProvidersConfig.claude;
    expect(config?.apiKey).toBe('sk-test');
    // Updating another field must not clobber the chosen model.
    expect(config?.modelId).toBe('claude-opus-5');
  });

  it('falls back to the default provider when claude is disabled while selected', () => {
    const s = useSettingsStore.getState();
    s.setWebSearchProvider('claude');
    expect(useSettingsStore.getState().webSearchProviderId).toBe('claude');

    s.setWebSearchProviderConfig('claude', { enabled: false });
    expect(useSettingsStore.getState().webSearchProviderId).toBe('tavily');
  });
});
