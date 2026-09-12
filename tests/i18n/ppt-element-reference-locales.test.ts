import { describe, expect, it } from 'vitest';
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

const locales = { arSA, deDE, enUS, esMX, frFR, jaJP, koKR, ptBR, ruRU, viVN, zhCN, zhTW };
const coursewareInstructions: Record<keyof typeof locales, string> = {
  arSA: 'انقر على عنصر في المادة التعليمية · Esc للخروج',
  deDE: 'Kursmaterialelement anklicken · Esc zum Beenden',
  enUS: 'Click a courseware element · Esc to exit',
  esMX: 'Haz clic en un elemento del material del curso · Esc para salir',
  frFR: 'Cliquez sur un élément du support de cours · Échap pour quitter',
  jaJP: '教材要素をクリック · Esc で終了',
  koKR: '강의 자료 요소를 클릭하세요 · Esc로 종료',
  ptBR: 'Clique em um elemento do material do curso · Esc para sair',
  ruRU: 'Нажмите на элемент учебного материала · Esc для выхода',
  viVN: 'Nhấp vào một phần tử trong học liệu · Esc để thoát',
  zhCN: '点击一个课件元素 · Esc 退出',
  zhTW: '點選一個課件元素 · Esc 退出',
};
const referenceKeys = [
  'button',
  'unavailable',
  'instruction',
  'fallback',
  'clear',
  'summary.noText',
  'summary.emptyContent',
  'summary.code',
  'summary.line',
  'summary.imageMetadata',
  'summary.videoMetadata',
  'summary.audioMetadata',
] as const;

const elementTypeKeys = [
  'text',
  'image',
  'shape',
  'line',
  'chart',
  'table',
  'latex',
  'video',
  'audio',
  'code',
] as const;

function getValue(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
  }, source);
}

describe('courseware element reference locale coverage', () => {
  it.each(Object.entries(coursewareInstructions))(
    '%s describes the unified courseware picker rather than a slide-only picker',
    (code, instruction) => {
      expect(locales[code as keyof typeof locales].chat.elementReference.instruction).toBe(
        instruction,
      );
    },
  );

  it.each(Object.entries(locales))('%s defines every user-facing reference label', (code, data) => {
    for (const key of referenceKeys) {
      const value = getValue(data.chat.elementReference, key);
      expect(typeof value, `${code} missing chat.elementReference.${key}`).toBe('string');
      expect(
        (value as string).trim(),
        `${code} has an empty chat.elementReference.${key}`,
      ).not.toBe('');
    }

    for (const key of elementTypeKeys) {
      const value = getValue(data.edit.element, key);
      expect(typeof value, `${code} missing edit.element.${key}`).toBe('string');
      expect((value as string).trim(), `${code} has an empty edit.element.${key}`).not.toBe('');
    }

    expect(typeof data.edit.sceneType.interactive).toBe('string');
    expect(data.edit.sceneType.interactive.trim()).not.toBe('');
  });
});
