import { describe, it, expect } from 'vitest';
import arSA from '@/lib/i18n/locales/ar-SA.json';
import deDE from '@/lib/i18n/locales/de-DE.json';
import enUS from '@/lib/i18n/locales/en-US.json';
import esMX from '@/lib/i18n/locales/es-MX.json';
import frFR from '@/lib/i18n/locales/fr-FR.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import koKR from '@/lib/i18n/locales/ko-KR.json';
import ptBR from '@/lib/i18n/locales/pt-BR.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import viVN from '@/lib/i18n/locales/vi-VN.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';

const locales = {
  'ar-SA': arSA,
  'de-DE': deDE,
  'en-US': enUS,
  'es-MX': esMX,
  'fr-FR': frFR,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'pt-BR': ptBR,
  'ru-RU': ruRU,
  'vi-VN': viVN,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

// The copy the settings Skills section renders through `t('settings.skills.*')`.
const KEYS = [
  'settings.skills.nav',
  'settings.skills.title',
  'settings.skills.description',
  'settings.skills.mySkills',
  'settings.skills.builtinSkills',
  'settings.skills.emptyMySkills',
  'settings.skills.emptyBuiltinSkills',
  'settings.skills.listFailed',
  'settings.skills.retry',
  'settings.skills.badgeBuiltin',
  'settings.skills.badgeOwner',
  'settings.skills.badgeConstraints',
  'settings.skills.details',
  'settings.skills.download',
  'settings.skills.detailFailed',
  'settings.skills.contentLabel',
  'settings.skills.builtinDetailNote',
  'settings.skills.upload',
  'settings.skills.uploading',
  'settings.skills.uploadFailed',
  'settings.skills.delete',
  'settings.skills.deleting',
  'settings.skills.deleteTitle',
  'settings.skills.deleteConfirm',
  'settings.skills.deleteFailed',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- locale JSON traversal
const get = (o: any, k: string) => k.split('.').reduce((a, p) => a?.[p], o);

describe('skill settings locale coverage', () => {
  it('every key exists, is non-empty, and does not echo the key, in all 12 locales', () => {
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
