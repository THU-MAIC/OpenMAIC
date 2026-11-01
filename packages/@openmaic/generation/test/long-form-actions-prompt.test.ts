/**
 * The long-form elaboration contract lives behind `{{#if longFormMode}}` in
 * `slide-actions/system.md`, and a variable the loader is not given reads as
 * false. The brief was threaded through but the flag was not, so the whole
 * section — "never announce a conclusion without the step that produces it",
 * the concrete-instance rule, the wrong-answer move — was removed from every
 * long-form slide prompt while the surrounding code said it was enabled.
 */
import { describe, expect, it } from 'vitest';

import { generateSceneActions } from '@openmaic/generation';
import type {
  AICallFn,
  GeneratedQuizContent,
  GeneratedSlideContent,
  SceneOutline,
} from '@openmaic/generation';

const ELABORATION = 'Long-Form Elaboration';
const SEGMENT_GUIDANCE = '9-16';

function slideOutline(): SceneOutline {
  return {
    id: 'scene-long-form',
    type: 'slide',
    title: 'Rate and receptor occupancy',
    description: 'Derives why the response saturates instead of rising forever.',
    keyPoints: ['a premise', 'an inference'],
    order: 7,
  };
}

const CONTENT: GeneratedSlideContent = {
  elements: [
    {
      id: 'text_title',
      type: 'text',
      left: 0,
      top: 0,
      width: 100,
      height: 40,
      content: '<p>Rate and receptor occupancy</p>',
      defaultFontName: '',
      defaultColor: '#000',
      rotate: 0,
    },
  ],
  background: undefined,
  remark: '',
};

function captureSystem(): { aiCall: AICallFn; system: () => string } {
  let system = '';
  const aiCall: AICallFn = async (promptSystem) => {
    system = promptSystem;
    return '[]';
  };
  return { aiCall, system: () => system };
}

function context(longFormBrief?: string) {
  return {
    pageIndex: 8,
    totalPages: 29,
    allTitles: Array.from({ length: 29 }, (_, index) => `Page ${index + 1}`),
    previousSpeeches: [],
    ...(longFormBrief ? { longFormBrief } : {}),
  };
}

describe('slide actions — long-form elaboration', () => {
  it('enables the elaboration contract when a brief is supplied', async () => {
    const { aiCall, system } = captureSystem();

    await generateSceneActions(slideOutline(), CONTENT, aiCall, {
      ctx: context('- Page 8 of 29 in a single 60-minute lesson.'),
    });

    expect(system()).toContain(ELABORATION);
    expect(system()).toContain(SEGMENT_GUIDANCE);
  });

  it('leaves the short-lesson prompt untouched', async () => {
    const { aiCall, system } = captureSystem();

    await generateSceneActions(slideOutline(), CONTENT, aiCall, { ctx: context() });

    expect(system()).not.toContain(ELABORATION);
    expect(system()).not.toContain(SEGMENT_GUIDANCE);
  });
});

/**
 * A retrieval page in a long-form course owns a two-to-three minute slot — the
 * plan puts one at every module end — but the short-lesson rule asked for one or
 * two sentences. The page then spent a fraction of its budget and the lesson ran
 * short, while the audit still passed because `estimatedDuration` was right.
 */
const QUIZ_CONTENT: GeneratedQuizContent = {
  questions: [
    {
      id: 'q1',
      type: 'single',
      question: 'Which patient should not be started on morphine?',
      options: [
        { value: 'A', label: 'A patient with severe renal colic' },
        { value: 'B', label: 'A patient with untreated respiratory depression' },
      ],
      answer: ['B'],
    },
  ],
};

function quizOutline(): SceneOutline {
  return {
    id: 'scene-quiz',
    type: 'quiz',
    title: 'Which patient, and why',
    description: 'Retrieval at the end of the clinical module.',
    keyPoints: ['a premise', 'an inference'],
    order: 11,
  };
}

describe('quiz actions — long-form pacing', () => {
  it('gives a long-form retrieval page a real slot', async () => {
    const { aiCall, system } = captureSystem();

    await generateSceneActions(quizOutline(), QUIZ_CONTENT, aiCall, {
      ctx: context('- Page 12 of 29: a two-minute retrieval beat.'),
    });

    expect(system()).toContain('3-5 segments');
    expect(system()).not.toContain('1-2 short segments');
  });

  it('keeps the short-lesson rule when there is no brief', async () => {
    const { aiCall, system } = captureSystem();

    await generateSceneActions(quizOutline(), QUIZ_CONTENT, aiCall, { ctx: context() });

    expect(system()).toContain('1-2 short segments');
  });
});
