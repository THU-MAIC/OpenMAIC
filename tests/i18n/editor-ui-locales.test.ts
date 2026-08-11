import { describe, expect, it } from 'vitest';
import arSA from '@/lib/i18n/locales/ar-SA.json';
import enUS from '@/lib/i18n/locales/en-US.json';
import esMX from '@/lib/i18n/locales/es-MX.json';
import frFR from '@/lib/i18n/locales/fr-FR.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import koKR from '@/lib/i18n/locales/ko-KR.json';
import ptBR from '@/lib/i18n/locales/pt-BR.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';

const locales = { arSA, enUS, esMX, frFR, jaJP, koKR, ptBR, ruRU, zhCN, zhTW };
const editorUiKeys = [
  'insert.toolbar',
  'asset.drop',
  'asset.orUrl',
  'asset.urlPlaceholder',
  'asset.insert',
  'asset.invalidType',
  'asset.readFailed',
  'element.toolbar',
  'image.toolbar',
  'background.color',
  'common.cancel',
  'common.confirm',
  'text.toolbar',
  'text.colorHex',
  'line.toolbar',
  'line.kind',
  'line.color',
  'line.width',
  'line.style',
  'line.start',
  'line.end',
  'line.straight',
  'line.broken',
  'line.broken2',
  'line.curve',
  'line.cubic',
  'line.solid',
  'line.dashed',
  'line.dotted',
  'line.none',
  'line.arrow',
  'line.dot',
] as const;

function getValue(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
  }, source);
}

describe('renderer editor locale coverage', () => {
  it.each(Object.entries(locales))('%s defines every renderer editor UI label', (code, data) => {
    for (const key of editorUiKeys) {
      const value = getValue(data.edit, key);
      expect(typeof value, `${code} missing edit.${key}`).toBe('string');
      expect((value as string).trim(), `${code} has an empty edit.${key}`).not.toBe('');
    }
  });
});
