import { describe, it, expect } from 'vitest';
import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import arSA from '@/lib/i18n/locales/ar-SA.json';

const locales = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'ru-RU': ruRU,
  'ar-SA': arSA,
};
const KEYS = [
  'edit.delete',
  'edit.text.label',
  'edit.text.font',
  'edit.text.fontDefault',
  'edit.text.sizeUp',
  'edit.text.sizeDown',
  'edit.text.bold',
  'edit.text.italic',
  'edit.text.underline',
  'edit.text.color',
  'edit.text.alignLeft',
  'edit.text.alignCenter',
  'edit.text.alignRight',
  'edit.text.bullet',
  'edit.insert.textBox',
  'edit.insert.image',
  'edit.insert.imageDrop',
  'edit.insert.imageOr',
  'edit.insert.imageUrlPlaceholder',
  'edit.insert.imageInsert',
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- locale JSON traversal
const get = (o: any, k: string) => k.split('.').reduce((a, p) => a?.[p], o);

describe('PR2 edit locale coverage', () => {
  it('every PR2 key exists, non-empty, not echoing the key, in all 6 locales', () => {
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
