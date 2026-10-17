import { describe, expect, it } from 'vitest';
import { getValidASRLanguage, resolveASRLanguage } from '@/lib/store/settings';

describe('runtime ASR language', () => {
  it('maps the locale to exact, base, then a same-language regional tag', () => {
    expect(resolveASRLanguage('browser-native', '', 'de-DE')).toBe('de-DE');
    expect(resolveASRLanguage('browser-native', '', 'zh-TW')).toBe('zh-TW');
    expect(resolveASRLanguage('openai-whisper', '', 'de-DE')).toBe('de');
    expect(resolveASRLanguage('openai-whisper', '', 'zh-TW')).toBe('zh');
    expect(resolveASRLanguage('browser-native', '', 'de-AT')).toBe('de-DE');
    expect(resolveASRLanguage('browser-native', '', 'EN_us')).toBe('en-US');
    expect(resolveASRLanguage('custom-asr-local', '', 'de-DE')).toBe('de');
  });

  it('uses auto or the first supported language when the locale is unsupported', () => {
    expect(resolveASRLanguage('funasr-asr', '', 'de-DE')).toBe('auto');
    expect(resolveASRLanguage('browser-native', '', 'xx-XX')).toBe('zh-CN');
  });

  it('keeps existing explicit choices and their existing provider validation', () => {
    expect(resolveASRLanguage('browser-native', 'zh-CN', 'de-DE')).toBe('zh-CN');
    expect(resolveASRLanguage('browser-native', 'en-US', 'zh-TW')).toBe('en-US');
    expect(resolveASRLanguage('openai-whisper', 'auto', 'de-DE')).toBe('auto');
    expect(resolveASRLanguage('openai-whisper', 'zh-CN', 'de-DE')).toBe(
      getValidASRLanguage('openai-whisper', 'zh-CN'),
    );
    expect(getValidASRLanguage('browser-native')).toBe('zh-CN');
  });
});
