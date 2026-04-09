import { describe, it, expect } from 'vitest';
import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';

const locales = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'ja-JP': jaJP,
  'ru-RU': ruRU,
} as const;

const outlineReviewKeys = [
  'generation.reviewOutlineTitle',
  'generation.reviewOutlineDesc',
  'generation.outlineEditorTitle',
  'generation.outlineEditorSummary',
  'generation.addScene',
  'generation.addFirstScene',
  'generation.noOutlines',
  'generation.sceneTitlePlaceholder',
  'generation.sceneTypeSlide',
  'generation.sceneTypeQuiz',
  'generation.sceneDescriptionLabel',
  'generation.sceneDescriptionPlaceholder',
  'generation.keyPointsLabel',
  'generation.keyPointsPlaceholder',
  'generation.quizConfigLabel',
  'generation.quizQuestionCount',
  'generation.quizDifficulty',
  'generation.quizType',
  'generation.quizDifficultyEasy',
  'generation.quizDifficultyMedium',
  'generation.quizDifficultyHard',
  'generation.quizTypeSingle',
  'generation.quizTypeMultiple',
  'generation.quizTypeText',
  'generation.backToRequirements',
  'generation.confirmAndGenerateCourse',
  'generation.generatingInProgress',
  'media.reviewOutline',
  'media.reviewOutlineHint',
] as const;

function getKey(
  locale: Record<string, unknown>,
  path: string,
): string | Record<string, unknown> | undefined {
  return path.split('.').reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
  }, locale) as string | Record<string, unknown> | undefined;
}

describe('outline review locale coverage', () => {
  it('defines outline review copy in every supported locale', () => {
    for (const [localeCode, localeData] of Object.entries(locales)) {
      for (const key of outlineReviewKeys) {
        const value = getKey(localeData, key);
        expect(value, `${localeCode} is missing ${key}`).toBeTypeOf('string');
        expect(value, `${localeCode} is missing ${key}`).not.toBe(key);
        expect((value as string).trim(), `${localeCode} has empty ${key}`).not.toBe('');
      }

      expect(
        getKey(localeData, 'generation.outlineEditorSummary'),
        `${localeCode} should preserve count interpolation`,
      ).toContain('{{count}}');
    }
  });
});
