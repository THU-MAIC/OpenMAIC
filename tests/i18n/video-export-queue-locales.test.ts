import { describe, it, expect } from 'vitest';
import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import koKR from '@/lib/i18n/locales/ko-KR.json';
import deDE from '@/lib/i18n/locales/de-DE.json';
import frFR from '@/lib/i18n/locales/fr-FR.json';
import esMX from '@/lib/i18n/locales/es-MX.json';
import ptBR from '@/lib/i18n/locales/pt-BR.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import viVN from '@/lib/i18n/locales/vi-VN.json';
import arSA from '@/lib/i18n/locales/ar-SA.json';

const locales = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'de-DE': deDE,
  'fr-FR': frFR,
  'es-MX': esMX,
  'pt-BR': ptBR,
  'ru-RU': ruRU,
  'vi-VN': viVN,
  'ar-SA': arSA,
};

// New keys introduced for the video-export queue admission signal (#1350).
const KEYS = ['export.videoQueueBusy'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- locale JSON traversal
const get = (o: any, k: string) => k.split('.').reduce((a, p) => a?.[p], o);

describe('video export queue locale coverage (#1350)', () => {
  it('every key exists, non-empty, and does not echo the key, in all 12 locales', () => {
    for (const [code, data] of Object.entries(locales)) {
      for (const k of KEYS) {
        const v = get(data, k);
        expect(typeof v, `${code} missing ${k}`).toBe('string');
        expect((v as string).trim(), `${code} empty ${k}`).not.toBe('');
        expect(v, `${code} echoes ${k}`).not.toBe(k);
      }
    }
  });
});
