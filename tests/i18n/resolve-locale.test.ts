import { describe, expect, it } from 'vitest';
import { defaultLocale } from '@/lib/i18n/types';
import {
  htmlLangFromLocale,
  matchLocale,
  parseAcceptLanguage,
  resolveLocale,
  resolveRequestLocale,
  serializeLocaleCookie,
  LOCALE_COOKIE_NAME,
} from '@/lib/i18n/resolve-locale';

describe('resolveLocale / matchLocale', () => {
  it('matches an exact supported tag', () => {
    expect(matchLocale('en-US')).toBe('en-US');
    expect(matchLocale('zh-TW')).toBe('zh-TW');
    expect(resolveLocale('ja-JP')).toBe('ja-JP');
  });

  it('matches exact tags case-insensitively', () => {
    expect(matchLocale('EN-us')).toBe('en-US');
    expect(matchLocale('Zh-Tw')).toBe('zh-TW');
  });

  it('maps unsupported tags via the language prefix', () => {
    expect(matchLocale('en')).toBe('en-US');
    expect(matchLocale('en-GB')).toBe('en-US');
    expect(matchLocale('zh')).toBe('zh-CN');
    expect(matchLocale('fr')).toBe('fr-FR');
    expect(matchLocale('pt')).toBe('pt-BR');
  });

  it('returns undefined from matchLocale when no prefix matches', () => {
    expect(matchLocale('xx')).toBeUndefined();
    expect(matchLocale('xx-YY')).toBeUndefined();
    expect(matchLocale('')).toBeUndefined();
    expect(matchLocale('   ')).toBeUndefined();
  });

  it('resolveLocale falls back to defaultLocale (zh-CN), not en-US', () => {
    expect(defaultLocale).toBe('zh-CN');
    expect(resolveLocale('xx-YY')).toBe('zh-CN');
    expect(resolveLocale('')).toBe(defaultLocale);
  });
});

describe('resolveRequestLocale priority', () => {
  it('prefers a supported cookie over Accept-Language', () => {
    expect(
      resolveRequestLocale({
        cookie: 'en-US',
        acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      }),
    ).toBe('en-US');
  });

  it('maps a prefix cookie before consulting Accept-Language', () => {
    expect(
      resolveRequestLocale({
        cookie: 'ja',
        acceptLanguage: 'en-US',
      }),
    ).toBe('ja-JP');
  });

  it('falls through an unsupported cookie to Accept-Language', () => {
    expect(
      resolveRequestLocale({
        cookie: 'xx-YY',
        acceptLanguage: 'ko,en;q=0.8',
      }),
    ).toBe('ko-KR');
  });

  it('uses Accept-Language when no cookie is set', () => {
    expect(
      resolveRequestLocale({
        cookie: null,
        acceptLanguage: 'en-US,en;q=0.9',
      }),
    ).toBe('en-US');
  });

  it('honours Accept-Language quality values', () => {
    expect(
      resolveRequestLocale({
        acceptLanguage: 'en;q=0.8,ja-JP;q=0.9',
      }),
    ).toBe('ja-JP');
  });

  it('maps unsupported Accept-Language tags via prefix', () => {
    expect(resolveRequestLocale({ acceptLanguage: 'de-AT,de;q=0.9' })).toBe('de-DE');
    expect(resolveRequestLocale({ acceptLanguage: 'pt-PT' })).toBe('pt-BR');
  });

  it('falls back to defaultLocale when cookie and header are missing or unsupported', () => {
    expect(resolveRequestLocale({})).toBe(defaultLocale);
    expect(resolveRequestLocale({ cookie: '', acceptLanguage: '' })).toBe(defaultLocale);
    expect(resolveRequestLocale({ cookie: 'xx', acceptLanguage: 'zz' })).toBe(defaultLocale);
  });
});

describe('parseAcceptLanguage', () => {
  it('drops * and sorts by q', () => {
    expect(parseAcceptLanguage('fr-FR,fr;q=0.8,en-US,*;q=0.5')).toEqual(['fr-FR', 'en-US', 'fr']);
  });
});

describe('htmlLangFromLocale', () => {
  it('uses the language subtag of the resolved locale', () => {
    expect(htmlLangFromLocale('zh-CN')).toBe('zh');
    expect(htmlLangFromLocale('zh-TW')).toBe('zh');
    expect(htmlLangFromLocale('en-US')).toBe('en');
    expect(htmlLangFromLocale('pt-BR')).toBe('pt');
  });
});

describe('serializeLocaleCookie', () => {
  it('writes the shared locale cookie name', () => {
    const serialized = serializeLocaleCookie('en-US');
    expect(serialized.startsWith(`${LOCALE_COOKIE_NAME}=en-US;`)).toBe(true);
    expect(serialized).toContain('Path=/');
    expect(serialized).toContain('SameSite=Lax');
  });
});
