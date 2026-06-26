import { describe, expect, it } from 'vitest';
import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import arSA from '@/lib/i18n/locales/ar-SA.json';
import koKR from '@/lib/i18n/locales/ko-KR.json';
import ptBR from '@/lib/i18n/locales/pt-BR.json';

const locales = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'ru-RU': ruRU,
  'ar-SA': arSA,
  'ko-KR': koKR,
  'pt-BR': ptBR,
} as const;

const outlineReviewKeys = [
  'generation.reviewOutlineTitle',
  'generation.reviewOutlineDesc',
  'generation.reviewOutlineAutoContinue',
  'generation.outlineEditorTitle',
  'generation.outlineEditorSummary',
  'generation.addFirstScene',
  'generation.noOutlines',
  'generation.sceneTitlePlaceholder',
  'generation.sceneTypeSlide',
  'generation.sceneTypeQuiz',
  'generation.sceneTypeInteractive',
  'generation.sceneTypePbl',
  'generation.sceneDescriptionPlaceholder',
  'generation.quizQuestionCount',
  'generation.quizDifficulty',
  'generation.quizType',
  'generation.quizDifficultyEasy',
  'generation.quizDifficultyMedium',
  'generation.quizDifficultyHard',
  'generation.quizTypeSingle',
  'generation.quizTypeMultiple',
  'generation.quizTypeText',
  'generation.alwaysReviewOutlines',
  'generation.dragSceneHint',
  'generation.deleteScene',
  'generation.backToRequirements',
  'generation.confirmAndGenerateCourse',
  'generation.generatingInProgress',
  'generation.sceneGenerateFailed',
  'generation.outlineEditorEyebrow',
  'generation.outlineEditorStreamingProgress',
  'generation.outlineEditorStreamingWaiting',
  'generation.outlineEditorWaitingConfirm',
  'generation.outlineExpandHint',
  'generation.reviewOutlineStreamingDesc',
  'generation.addKeyPoint',
  'generation.removeKeyPoint',
  'generation.insertSceneHere',
  'generation.deleteSceneConfirm',
  'generation.deleteSceneConfirmDesc',
  'generation.deleteSceneConfirmAction',
  'generation.collapseEditor',
  'generation.quizConfigSummary',
  'generation.interactiveWidgetKind',
  'generation.widgetSimulation',
  'generation.widgetDiagram',
  'generation.widgetCode',
  'generation.widgetGame',
  'generation.widgetVisualization3d',
  'generation.interactiveConcept',
  'generation.interactiveConceptPlaceholder',
  'generation.pblConfigSummary',
  'generation.pblSubtype',
  'generation.pblSubtypeProject',
  'generation.pblSubtypeScenario',
  'generation.pblProjectTopic',
  'generation.pblProjectTopicPlaceholder',
  'generation.pblProjectDescription',
  'generation.pblProjectDescriptionPlaceholder',
  'generation.pblScenarioBrief',
  'generation.pblScenarioBriefPlaceholder',
  'generation.pblTargetSkills',
  'generation.pblAddSkill',
  'generation.widgetProceduralSkill',
  'generation.removeSkill',
] as const;

const countInterpolatedKeys = [
  'generation.outlineEditorSummary',
  'generation.outlineEditorStreamingProgress',
  'generation.quizConfigSummary',
] as const;

function getKey(locale: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
  }, locale);
}

describe('outline review locale coverage', () => {
  it('defines outline review copy in every supported locale', () => {
    for (const [localeCode, localeData] of Object.entries(locales)) {
      for (const key of outlineReviewKeys) {
        const value = getKey(localeData, key);

        expect(value, `${localeCode} is missing ${key}`).toBeTypeOf('string');
        expect(value, `${localeCode} should not echo ${key}`).not.toBe(key);
        expect((value as string).trim(), `${localeCode} has empty ${key}`).not.toBe('');
      }

      for (const key of countInterpolatedKeys) {
        expect(
          getKey(localeData, key),
          `${localeCode} should preserve {{count}} in ${key}`,
        ).toContain('{{count}}');
      }
    }
  });
});
