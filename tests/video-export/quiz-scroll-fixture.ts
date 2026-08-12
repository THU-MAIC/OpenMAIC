import type { Action } from '@openmaic/dsl';
import type { CompilerScene, QuizLayoutMeasurement } from '@/lib/video-export';

export const QUIZ_SCROLL_TITLE =
  'Quiz：确定性导出与超长标题排版验证 SupercalifragilisticexpialidociousWithoutBreaks';

export const QUIZ_SCROLL_QUESTIONS: readonly unknown[] = Array.from({ length: 9 }, (_, index) => ({
  id: `long-${index + 1}`,
  type: index % 3 === 0 ? 'short_answer' : index % 2 === 0 ? 'multiple' : 'single',
  question:
    index % 2 === 0
      ? `第 ${index + 1} 题：请结合公式 $a^2+b^2=c^2$ 解释这个较长的中文问题，并注意公式字体和多行排版保持稳定。`
      : `Question ${index + 1}: choose the statement that correctly explains $\\sqrt{x^2}=|x|$ across a deliberately long Latin prompt.`,
  options: [
    { value: 'A', label: 'A concise option with $x^2$.' },
    { value: 'B', label: '一个包含 $\\frac{a}{b}$ 的较长中文选项，用于验证真实换行。' },
    { value: 'C', label: 'Supercalifragilisticexpialidocious wraps without escaping.' },
  ],
  answer: ['A'],
  analysis: 'SECRET_SAMPLE_ANALYSIS',
}));

/** Chromium-pinned geometry for this exact shared fixture at 1280×720. */
export const QUIZ_SCROLL_LAYOUT_720P: QuizLayoutMeasurement = {
  contentHeightPx: 2170,
  viewportHeightPx: 475,
  frameHeightPx: 720,
};

export function quizScrollScene(order = 0): CompilerScene {
  return {
    id: `quiz-${order}`,
    stageId: 'stage',
    title: QUIZ_SCROLL_TITLE,
    order,
    type: 'quiz',
    content: { type: 'quiz', questions: QUIZ_SCROLL_QUESTIONS },
    actions: [
      {
        id: `quiz-narration-${order}`,
        type: 'speech',
        text: '字幕与 Quiz 封面同时显示，用于验证长文本卡片不会遮挡底部字幕。',
      } as Action,
    ],
  } as CompilerScene;
}
