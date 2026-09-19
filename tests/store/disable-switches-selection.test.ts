/**
 * Regression (#784): disabling the currently-selected media/TTS/web-search
 * provider must switch the active selection away from that provider. Otherwise
 * removing a token plan (which disables its providers) leaves the app pointed
 * at a disabled provider with an empty key, and the next generation fails.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '@/lib/store/settings';

describe('disabling the active provider switches selection away', () => {
  beforeEach(() => {
    // Reset selections to known non-default providers per test below.
    useSettingsStore.setState({
      imageProviderId: 'seedream',
      videoProviderId: 'seedance',
      ttsProviderId: 'browser-native-tts',
      webSearchProviderId: 'tavily',
    });
  });

  it('image: disabling the selected provider falls back to seedream', () => {
    const s = useSettingsStore.getState();
    s.setImageProvider('openai-image');
    expect(useSettingsStore.getState().imageProviderId).toBe('openai-image');

    s.setImageProviderConfig('openai-image', { enabled: false });
    expect(useSettingsStore.getState().imageProviderId).toBe('seedream');
  });

  it('image: disabling the default selected provider does not select itself', () => {
    useSettingsStore.setState((state) => ({
      imageProviderId: 'seedream',
      imageGenerationEnabled: true,
      imageProvidersConfig: {
        ...state.imageProvidersConfig,
        seedream: { apiKey: 'ark-test', baseUrl: '', enabled: true },
        'openai-image': { apiKey: '', baseUrl: '', enabled: false },
      },
    }));

    const s = useSettingsStore.getState();
    s.setImageProviderConfig('seedream', { apiKey: '', enabled: false });
    expect(useSettingsStore.getState().imageProviderId).not.toBe('seedream');
    expect(useSettingsStore.getState().imageGenerationEnabled).toBe(false);
  });

  it('image: disabling a NON-selected provider leaves the selection alone', () => {
    const s = useSettingsStore.getState();
    s.setImageProvider('seedream');
    s.setImageProviderConfig('openai-image', { enabled: false });
    expect(useSettingsStore.getState().imageProviderId).toBe('seedream');
  });

  it('video: disabling the selected provider falls back to seedance', () => {
    const s = useSettingsStore.getState();
    s.setVideoProvider('kling');
    expect(useSettingsStore.getState().videoProviderId).toBe('kling');

    s.setVideoProviderConfig('kling', { enabled: false });
    expect(useSettingsStore.getState().videoProviderId).toBe('seedance');
  });

  it('video: disabling the default selected provider does not select itself', () => {
    useSettingsStore.setState((state) => ({
      videoProviderId: 'seedance',
      videoGenerationEnabled: true,
      videoProvidersConfig: {
        ...state.videoProvidersConfig,
        seedance: { apiKey: 'ark-test', baseUrl: '', enabled: true },
        kling: { apiKey: '', baseUrl: '', enabled: false },
      },
    }));

    const s = useSettingsStore.getState();
    s.setVideoProviderConfig('seedance', { apiKey: '', enabled: false });
    expect(useSettingsStore.getState().videoProviderId).not.toBe('seedance');
    expect(useSettingsStore.getState().videoGenerationEnabled).toBe(false);
  });

  it('tts: disabling the selected provider falls back to browser TTS', () => {
    const s = useSettingsStore.getState();
    s.setTTSProvider('openai-tts');
    expect(useSettingsStore.getState().ttsProviderId).toBe('openai-tts');

    s.setTTSProviderConfig('openai-tts', { enabled: false });
    expect(useSettingsStore.getState().ttsProviderId).toBe('browser-native-tts');
  });

  it('web search: disabling the selected provider falls back to tavily', () => {
    const s = useSettingsStore.getState();
    s.setWebSearchProvider('bocha');
    expect(useSettingsStore.getState().webSearchProviderId).toBe('bocha');

    s.setWebSearchProviderConfig('bocha', { enabled: false });
    expect(useSettingsStore.getState().webSearchProviderId).toBe('tavily');
  });

  it('enabling/other edits do NOT force a switch away', () => {
    const s = useSettingsStore.getState();
    s.setImageProvider('openai-image');
    s.setImageProviderConfig('openai-image', { apiKey: 'sk-x', enabled: true });
    expect(useSettingsStore.getState().imageProviderId).toBe('openai-image');
  });
});
