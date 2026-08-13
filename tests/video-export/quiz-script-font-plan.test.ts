import { describe, expect, it } from 'vitest';
import {
  renderQuizQuestionListSurface,
  type QuizQuestionListContent,
} from '@/lib/video-export/emit-hyperframes/quiz-question-list';
import {
  planQuizScriptFonts,
  type QuizScriptFont,
} from '@/lib/video-export/emit-hyperframes/quiz-script-font-plan';

describe('Quiz script-font plan', () => {
  it('does not select vendored script fonts for Latin-only rendered markup', () => {
    expect(planQuizScriptFonts(['<article>Find the value of x.</article>'])).toEqual({
      scripts: [],
      measurementCss: '',
      exportCss: '',
      assets: [],
      licenses: [],
      requiredFontLoads: [],
    });
  });

  it('does not treat a decomposed Latin accent as Cyrillic text', () => {
    expect(planQuizScriptFonts(['<article>Cafe\u0301</article>']).scripts).toEqual([]);
  });

  it.each(['Latin ؟ punctuation', '؟،؛ـ'])(
    'selects Arabic for extension-only rendered markup: %s',
    (markup) => {
      const plan = planQuizScriptFonts([`<article>${markup}</article>`]);

      expect(plan.scripts).toEqual(['arabic']);
      expect(plan.assets.map(({ path }) => path)).toEqual([
        'assets/fonts/noto-sans-arabic-arabic-400-normal.woff2',
      ]);
    },
  );

  it('selects both Noto Sans Cyrillic subsets and their required load sample for Cyrillic markup', () => {
    const plan = planQuizScriptFonts(['<article>Решите уравнение Ёж</article>']);

    expect(plan.scripts).toEqual(['cyrillic']);
    expect(plan.measurementCss).toContain('font-family:"OpenMAIC Noto Sans Cyrillic"');
    expect(plan.measurementCss).toContain('/vendor/video-export/fonts/');
    expect(plan.exportCss).toContain('assets/fonts/');
    expect(plan.assets.map(({ path }) => path)).toEqual([
      'assets/fonts/noto-sans-cyrillic-400-normal.woff2',
      'assets/fonts/noto-sans-cyrillic-ext-400-normal.woff2',
    ]);
    expect(plan.licenses.map(({ path }) => path)).toEqual(['LICENSES/Noto-Sans-OFL-1.1.txt']);
    expect(plan.requiredFontLoads).toEqual([
      { family: 'OpenMAIC Noto Sans Cyrillic', text: 'Привет Ёж Ԁ' },
    ]);
    expect(plan.requiredFontLoads[0].text).toMatch(/[\u0500-\u052f]/u);
  });

  it('selects Noto Sans Arabic and its required load sample for Arabic markup', () => {
    const plan = planQuizScriptFonts(['<article dir="rtl">حل المسألة</article>']);

    expect(plan.scripts).toEqual(['arabic']);
    expect(plan.measurementCss).toContain('font-family:"OpenMAIC Noto Sans Arabic"');
    expect(plan.measurementCss).toContain('/vendor/video-export/fonts/');
    expect(plan.exportCss).toContain('assets/fonts/');
    expect(plan.assets.map(({ path }) => path)).toEqual([
      'assets/fonts/noto-sans-arabic-arabic-400-normal.woff2',
    ]);
    expect(plan.licenses.map(({ path }) => path)).toEqual([
      'LICENSES/Noto-Sans-Arabic-OFL-1.1.txt',
    ]);
    expect(plan.requiredFontLoads).toEqual([
      { family: 'OpenMAIC Noto Sans Arabic', text: 'العربية' },
    ]);
  });

  it('uses a stable Cyrillic-before-Arabic union across separate rendered surfaces', () => {
    const plan = planQuizScriptFonts(['<article>العربية</article>', '<article>Русский</article>']);

    expect(plan.scripts).toEqual(['cyrillic', 'arabic']);
    expect(plan.assets.map(({ path }) => path)).toEqual([
      'assets/fonts/noto-sans-cyrillic-400-normal.woff2',
      'assets/fonts/noto-sans-cyrillic-ext-400-normal.woff2',
      'assets/fonts/noto-sans-arabic-arabic-400-normal.woff2',
    ]);
    expect(new Set(plan.assets.map(({ path }) => path)).size).toBe(plan.assets.length);
    expect(new Set(plan.licenses.map(({ path }) => path)).size).toBe(plan.licenses.length);
    expect(new Set(plan.requiredFontLoads.map(({ family }) => family)).size).toBe(
      plan.requiredFontLoads.length,
    );
  });

  it.each([
    {
      name: 'outside the declared Cyrillic ranges',
      character: '\u1d2b',
      script: 'cyrillic',
      family: 'OpenMAIC Noto Sans Cyrillic',
      sample: 'Привет Ёж Ԁ',
    },
    {
      name: 'declared by Fontsource metadata but absent from the Cyrillic WOFF2 cmap',
      character: '\u1c89',
      script: 'cyrillic',
      family: 'OpenMAIC Noto Sans Cyrillic',
      sample: 'Привет Ёж Ԁ',
    },
    {
      name: 'declared by Fontsource metadata but absent from the Arabic WOFF2 cmap',
      character: '\u0897',
      script: 'arabic',
      family: 'OpenMAIC Noto Sans Arabic',
      sample: 'العربية',
    },
  ] as const)('adds a fail-closed load for $name', ({ character, script, family, sample }) => {
    const plan = planQuizScriptFonts([`<article>Unsupported character: ${character}</article>`]);

    expect(plan.scripts).toEqual([script]);
    expect(plan.requiredFontLoads).toEqual([
      { family, text: sample },
      { family, text: character },
    ]);
  });

  it('selects only the localized question-type label that the rendered question uses', () => {
    const cases: {
      question: QuizQuestionListContent['questions'][number];
      labels: { singleChoice: string; multipleChoice: string };
      expected: QuizScriptFont[];
    }[] = [
      {
        question: { id: 'single', type: 'single', question: 'Visible prompt', options: [] },
        labels: { singleChoice: 'Кириллица', multipleChoice: 'غير مستخدم' },
        expected: ['cyrillic'],
      },
      {
        question: { id: 'multiple', type: 'multiple', question: 'Visible prompt', options: [] },
        labels: { singleChoice: 'Не используется', multipleChoice: 'العربية' },
        expected: ['arabic'],
      },
    ];

    for (const { question, labels, expected } of cases) {
      const surfaceMarkup = renderQuizQuestionListSurface(
        { title: 'Visible Latin title', questions: [question] },
        { ...labels, shortAnswer: 'Short answer', answerPlaceholder: 'Write your answer' },
        'ltr',
      );

      expect(planQuizScriptFonts([surfaceMarkup]).scripts).toEqual(expected);
    }
  });

  it('does not select a font for authored non-visible data omitted by the rendered Quiz markup', () => {
    const surfaceMarkup = renderQuizQuestionListSurface(
      {
        title: 'Visible Latin title',
        questions: [
          {
            type: 'single',
            question: 'Visible Latin question',
            options: [{ value: 'A', label: 'Visible choice' }],
            answer: ['إجابة مخفية'],
            analysis: 'Скрытый анализ',
          } as never,
        ],
      },
      {
        singleChoice: 'Single choice',
        multipleChoice: 'Multiple choice',
        shortAnswer: 'Short answer',
        answerPlaceholder: 'Write your answer',
      },
      'ltr',
    );

    expect(surfaceMarkup).not.toContain('إجابة مخفية');
    expect(surfaceMarkup).not.toContain('Скрытый анализ');
    expect(planQuizScriptFonts([surfaceMarkup]).scripts).toEqual([]);
  });
});
