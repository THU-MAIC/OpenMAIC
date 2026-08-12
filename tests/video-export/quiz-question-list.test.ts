import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/dsl';
import {
  compileVideoTimeline,
  prepareQuizQuestionList,
  type CompilerScene,
  type QuizLayoutProbe,
} from '@/lib/video-export';
import { NO_ASSETS, stubProbe } from './helpers';

const speech = (id: string): Action =>
  ({ id, type: 'speech', text: `Narration for ${id}` }) as Action;

function scene(questions: readonly unknown[], order = 0): CompilerScene {
  return {
    id: `quiz-${order}`,
    stageId: 'stage',
    title: `Quiz ${order}`,
    order,
    type: 'quiz',
    content: { type: 'quiz', questions },
    actions: [speech(`speech-${order}`)],
  } as CompilerScene;
}

const measured: QuizLayoutProbe = {
  measureQuestionList: () => ({
    contentHeightPx: 1001,
    viewportHeightPx: 401,
    frameHeightPx: 720,
  }),
};

describe('Quiz question-list preparation', () => {
  it('whitelists only learner-visible fields across all three question types', () => {
    const questions = prepareQuizQuestionList(
      scene([
        {
          id: 'single',
          type: 'single',
          question: 'Choose <one>',
          options: [
            { value: 'A', label: 'Alpha' },
            { value: 'B', label: 'Beta', correct: true },
          ],
          answer: ['B'],
          analysis: 'SECRET_ANALYSIS',
          points: 99,
          attempt: { answer: 'B' },
        },
        {
          id: 'multiple',
          type: 'multiple',
          question: 'Choose several',
          options: ['Legacy option', { value: 'Z', label: 'Last' }],
          submission: ['SECRET_SUBMISSION'],
        },
        {
          id: 'short',
          type: 'short_answer',
          question: 'Explain $x^2$',
          options: [{ value: 'LEAK', label: 'SECRET_OPTION' }],
          commentPrompt: 'SECRET_RUBRIC',
          review: 'SECRET_REVIEW',
        },
      ]),
    );

    expect(questions).toEqual([
      {
        id: 'single',
        type: 'single',
        question: 'Choose <one>',
        options: [
          { value: 'A', label: 'Alpha' },
          { value: 'B', label: 'Beta' },
        ],
      },
      {
        id: 'multiple',
        type: 'multiple',
        question: 'Choose several',
        options: [
          { value: 'A', label: 'Legacy option' },
          { value: 'Z', label: 'Last' },
        ],
      },
      { id: 'short', type: 'short_answer', question: 'Explain $x^2$' },
    ]);
    expect(JSON.stringify(questions)).not.toMatch(
      /SECRET_(ANALYSIS|SUBMISSION|OPTION|RUBRIC|REVIEW)/,
    );
  });

  it('skips malformed questions and safely normalizes damaged option data', () => {
    const questions = prepareQuizQuestionList(
      scene([
        null,
        { id: '', type: 'single', question: 'missing id' },
        { id: 'bad-type', type: 'essay', question: 'unsupported' },
        { id: 'bad-question', type: 'single', question: 42 },
        {
          id: 'ok',
          type: 'single',
          question: 'Still renderable',
          options: [null, 7, { value: 'A' }, { label: 'No value' }, ' Visible '],
        },
      ]),
    );

    expect(questions).toMatchObject([
      {
        id: 'ok',
        type: 'single',
        question: 'Still renderable',
        options: [{ label: 'Visible' }],
      },
    ]);
  });
});

describe('Quiz question-list timeline planning', () => {
  it('adds a measured list, preserves narration, and extends the Quiz deterministically', () => {
    const ir = compileVideoTimeline(
      {
        stage: { id: 'stage', name: 'Measured Quiz' },
        scenes: [scene([{ id: 'q', type: 'single', question: 'Question' }])],
      },
      {
        timing: stubProbe({ 'speech-0': 2400 }),
        assets: NO_ASSETS,
        quizLayout: measured,
      },
    );

    expect(ir.totalDurationMs).toBe(11_650);
    expect(ir.scenes[0]).toMatchObject({
      startMs: 0,
      durationMs: 11_650,
      narration: [{ startMs: 0, durationMs: 2400 }],
      visuals: [
        { kind: 'quiz-cover', startMs: 0, durationMs: 3000 },
        {
          kind: 'quiz-question-list',
          startMs: 2400,
          durationMs: 9250,
          contentHeightPx: 1001,
          viewportHeightPx: 401,
          scrollDistancePx: 600,
          pixelsPerSecond: 96,
          transitionDurationMs: 600,
          topHoldDurationMs: 1200,
          scrollDurationMs: 6250,
          bottomHoldDurationMs: 1200,
        },
      ],
    });
    expect(ir.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'cover-card',
        sceneId: 'quiz-0',
        message: expect.stringContaining('cover-to-question-list sequence'),
      }),
    );
  });

  it('uses a static 2.4s hold when the measured list fits the viewport', () => {
    const fitProbe: QuizLayoutProbe = {
      measureQuestionList: () => ({
        contentHeightPx: 400,
        viewportHeightPx: 400,
        frameHeightPx: 1080,
      }),
    };
    const ir = compileVideoTimeline(
      {
        stage: { id: 'stage', name: 'Fit Quiz' },
        scenes: [scene([{ id: 'q', type: 'short_answer', question: 'Question' }])],
      },
      { timing: stubProbe({ 'speech-0': 2400 }), assets: NO_ASSETS, quizLayout: fitProbe },
    );
    const list = ir.scenes[0].visuals[1];

    expect(list).toMatchObject({
      kind: 'quiz-question-list',
      scrollDistancePx: 0,
      pixelsPerSecond: 0,
      scrollDurationMs: 0,
      durationMs: 3000,
    });
    expect(ir.totalDurationMs).toBe(5400);
  });

  it('scales the 96px/s baseline with frame height at an equivalent visual duration', () => {
    const compileAt = (frameHeightPx: number, scrollDistancePx: number) => {
      const viewportHeightPx = 400;
      const ir = compileVideoTimeline(
        {
          stage: { id: 'stage', name: `${frameHeightPx}p Quiz` },
          scenes: [scene([{ id: 'q', type: 'single', question: 'Question' }])],
        },
        {
          timing: stubProbe({ 'speech-0': 1000 }),
          assets: NO_ASSETS,
          quizLayout: {
            measureQuestionList: () => ({
              contentHeightPx: viewportHeightPx + scrollDistancePx,
              viewportHeightPx,
              frameHeightPx,
            }),
          },
        },
      );
      return ir.scenes[0].visuals[1];
    };

    expect(compileAt(720, 960)).toMatchObject({
      pixelsPerSecond: 96,
      scrollDurationMs: 10_000,
    });
    expect(compileAt(1080, 1440)).toMatchObject({
      pixelsPerSecond: 144,
      scrollDurationMs: 10_000,
    });
  });

  it('keeps empty, missing-probe, and failed measurements on the existing cover-only path', () => {
    const failed: QuizLayoutProbe = { measureQuestionList: () => null };
    const empty = compileVideoTimeline(
      { stage: { id: 'stage', name: 'Empty' }, scenes: [scene([])] },
      { timing: stubProbe({ 'speech-0': 2400 }), assets: NO_ASSETS, quizLayout: measured },
    );
    const missing = compileVideoTimeline(
      {
        stage: { id: 'stage', name: 'Missing' },
        scenes: [scene([{ id: 'q', type: 'single', question: 'Q' }])],
      },
      { timing: stubProbe({ 'speech-0': 2400 }), assets: NO_ASSETS },
    );
    const unavailable = compileVideoTimeline(
      {
        stage: { id: 'stage', name: 'Failed' },
        scenes: [scene([{ id: 'q', type: 'single', question: 'Q' }])],
      },
      { timing: stubProbe({ 'speech-0': 2400 }), assets: NO_ASSETS, quizLayout: failed },
    );

    expect(empty.totalDurationMs).toBe(2400);
    expect(empty.scenes[0].visuals).toHaveLength(1);
    expect(missing.totalDurationMs).toBe(2400);
    expect(missing.scenes[0].visuals).toHaveLength(1);
    expect(unavailable.totalDurationMs).toBe(2400);
    expect(unavailable.scenes[0].visuals).toHaveLength(1);
    expect(empty.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'quiz-layout-unavailable' }),
    );
    expect(missing.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warn', code: 'quiz-layout-unavailable' }),
    );
    expect(unavailable.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warn', code: 'quiz-layout-unavailable' }),
    );
  });
});
