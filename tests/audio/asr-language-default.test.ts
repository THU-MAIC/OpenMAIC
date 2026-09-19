import { describe, expect, it } from 'vitest';
import { defaultASRLanguage } from '@/lib/audio/asr-language';
import { CUSTOM_ASR_DEFAULT_LANGUAGES } from '@/lib/audio/constants';
import { defaultLocale } from '@/lib/i18n/types';
import { getValidASRLanguage, useSettingsStore } from '@/lib/store/settings';

describe('defaultASRLanguage — the UI locale drives the ASR default', () => {
  it('picks the provider-shaped code for the locale: full tag, bare language, prefix match', () => {
    expect(defaultASRLanguage('browser-native', 'zh-CN')).toBe('zh-CN');
    expect(defaultASRLanguage('openai-whisper', 'zh-CN')).toBe('zh');
    expect(defaultASRLanguage('browser-native', 'tr-TR')).toBe('tr-TR');
    expect(defaultASRLanguage('openai-whisper', 'tr-TR')).toBe('tr');
    expect(defaultASRLanguage('browser-native', 'en-US')).toBe('en-US');
    expect(defaultASRLanguage('browser-native', 'de-DE')).toBe('de-DE');
    // Bare locale against a full-tag list → first entry sharing the prefix.
    expect(defaultASRLanguage('browser-native', 'de')).toBe('de-DE');
  });

  it('degrades to auto, then the first entry, then the locale itself', () => {
    // FunASR lists only auto/zh/en/ja/ko/yue.
    expect(defaultASRLanguage('funasr-asr', 'tr-TR')).toBe('auto');
    expect(CUSTOM_ASR_DEFAULT_LANGUAGES).toContain(defaultASRLanguage('custom-asr-x', 'zh-CN'));
    expect(defaultASRLanguage('no-such-provider', 'tr-TR')).toBe('tr-TR');
  });

  it('defaults to defaultLocale and feeds both the store default and the provider-switch fallback', () => {
    expect(defaultASRLanguage('browser-native')).toBe(
      defaultASRLanguage('browser-native', defaultLocale),
    );
    expect(useSettingsStore.getState().asrLanguage).toBe(defaultASRLanguage('browser-native'));
    // The provider-switch invariant (#1082) is untouched: it still validates against the list.
    expect(getValidASRLanguage('openai-whisper', 'ja')).toBe('ja');
    expect(getValidASRLanguage('openai-whisper', 'yue-Hant-HK')).toBe('auto');
    expect(getValidASRLanguage('browser-native', '')).toBe('zh-CN');
  });
});
