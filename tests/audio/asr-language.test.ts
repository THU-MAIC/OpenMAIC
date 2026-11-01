import { describe, expect, it } from 'vitest';
import { getValidASRLanguage, resolveASRLanguage } from '@/lib/store/settings';

describe('runtime ASR language', () => {
  it.each([
    'openai-whisper',
    'qwen-asr',
    'azure-asr',
    'funasr-asr',
    'lemonade-asr',
    'custom-asr-local',
  ] as const)('prefers automatic detection for an unset %s language', (providerId) => {
    expect(resolveASRLanguage(providerId, '', 'de-DE')).toBe('auto');
    expect(resolveASRLanguage(providerId, undefined, 'zh-TW')).toBe('auto');
    expect(resolveASRLanguage(providerId, '', 'xx-XX')).toBe('auto');
  });

  it('maps the locale for browser recognition, which needs an explicit language', () => {
    expect(resolveASRLanguage('browser-native', '', 'de-DE')).toBe('de-DE');
    expect(resolveASRLanguage('browser-native', '', 'zh-TW')).toBe('zh-TW');
    expect(resolveASRLanguage('browser-native', '', 'de-AT')).toBe('de-DE');
    expect(resolveASRLanguage('browser-native', '', 'EN_us')).toBe('en-US');
  });

  it('uses the first browser language when the locale is unsupported', () => {
    expect(resolveASRLanguage('browser-native', '', 'xx-XX')).toBe('zh-CN');
  });

  it('keeps existing explicit choices and their existing provider validation', () => {
    expect(resolveASRLanguage('browser-native', 'zh-CN', 'de-DE')).toBe('zh-CN');
    expect(resolveASRLanguage('browser-native', 'en-US', 'zh-TW')).toBe('en-US');
    expect(resolveASRLanguage('browser-native', 'auto', 'de-DE')).toBe('zh-CN');
    expect(resolveASRLanguage('openai-whisper', 'de', 'zh-TW')).toBe('de');
    expect(resolveASRLanguage('openai-whisper', 'zh', 'de-DE')).toBe('zh');
    expect(resolveASRLanguage('openai-whisper', 'auto', 'de-DE')).toBe('auto');
    expect(resolveASRLanguage('openai-whisper', 'zh-CN', 'de-DE')).toBe(
      getValidASRLanguage('openai-whisper', 'zh-CN'),
    );
    expect(getValidASRLanguage('browser-native')).toBe('zh-CN');
  });
});
