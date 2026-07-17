import { describe, expect, it } from 'vitest';
import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import koKR from '@/lib/i18n/locales/ko-KR.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import arSA from '@/lib/i18n/locales/ar-SA.json';
import ptBR from '@/lib/i18n/locales/pt-BR.json';

describe('edit_elements locale coverage', () => {
  it.each([enUS, zhCN, zhTW, jaJP, koKR, ruRU, arSA, ptBR])(
    'defines the client apply-failure correction',
    (locale) => {
      expect(locale.edit.editElements.applyFailed).toBeTruthy();
      expect(locale.edit.editElements.applyPartiallyFailed).toBeTruthy();
    },
  );
});
