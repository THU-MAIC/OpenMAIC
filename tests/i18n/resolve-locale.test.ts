import { describe, expect, it } from 'vitest';
import { matchLocale, resolveRequestLocale } from '@/lib/i18n/resolve-locale';

describe('matchLocale', () => {
  it('matches supported tags exactly, ignoring case', () => {
    expect(matchLocale('zh-TW')).toBe('zh-TW');
    expect(matchLocale('EN-us')).toBe('en-US');
  });

  it('maps other regions and bare languages to the first locale of that language', () => {
    expect(matchLocale('en-GB')).toBe('en-US');
    expect(matchLocale('zh')).toBe('zh-CN');
    expect(matchLocale('pt-PT')).toBe('pt-BR');
  });

  it('matches nothing for unsupported or empty tags', () => {
    expect(matchLocale('xx-YY')).toBeUndefined();
    expect(matchLocale('e')).toBeUndefined();
    expect(matchLocale(' ')).toBeUndefined();
    expect(matchLocale(null)).toBeUndefined();
  });
});

describe('resolveRequestLocale', () => {
  it('prefers the locale cookie over Accept-Language', () => {
    expect(resolveRequestLocale({ cookie: 'ja-JP', acceptLanguage: 'en-US,en;q=0.9' })).toBe(
      'ja-JP',
    );
  });

  it('falls through an unsupported cookie to Accept-Language', () => {
    expect(resolveRequestLocale({ cookie: 'xx', acceptLanguage: 'ko' })).toBe('ko-KR');
  });

  it('takes the most preferred supported Accept-Language tag', () => {
    expect(resolveRequestLocale({ acceptLanguage: 'en-US,en;q=0.9' })).toBe('en-US');
    expect(resolveRequestLocale({ acceptLanguage: 'xx,de;q=0.5,fr;q=0.8' })).toBe('fr-FR');
    expect(resolveRequestLocale({ acceptLanguage: 'en;q=0,*,ja;q=0.1' })).toBe('ja-JP');
  });

  it('falls back to defaultLocale', () => {
    expect(resolveRequestLocale({})).toBe('zh-CN');
    expect(resolveRequestLocale({ cookie: '', acceptLanguage: 'xx, *' })).toBe('zh-CN');
  });
});
