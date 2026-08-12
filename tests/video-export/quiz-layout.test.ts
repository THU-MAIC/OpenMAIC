import { describe, expect, it, vi } from 'vitest';
import type { CompilerScene, QuizLayoutMeasurement } from '@/lib/video-export';
import { createQuizLayoutProbe } from '@/lib/video-export-app/quiz-layout';
import { getVideoExportCoverLabels } from '@/lib/video-export-app/cover-config';

function quiz(id: string, questions: readonly unknown[]): CompilerScene {
  return {
    id,
    stageId: 'stage',
    title: id,
    order: 0,
    type: 'quiz',
    content: { type: 'quiz', questions },
    actions: [],
  } as CompilerScene;
}

describe('app-side Quiz layout probe', () => {
  it('premeasures non-empty Quiz scenes at the target frame and exposes sync lookups', async () => {
    const measurement: QuizLayoutMeasurement = {
      contentHeightPx: 900,
      viewportHeightPx: 500,
      frameHeightPx: 1080,
    };
    const measure = vi.fn().mockResolvedValue(measurement);
    const nonEmpty = quiz('non-empty', [{ id: 'q', type: 'single', question: 'Q' }]);
    const empty = quiz('empty', []);
    const nonQuiz = {
      ...quiz('slide', []),
      type: 'slide',
      content: { type: 'slide', canvas: { elements: [] } },
    } as CompilerScene;
    const probe = await createQuizLayoutProbe(
      {
        scenes: [nonEmpty, empty, nonQuiz],
        width: 1920,
        height: 1080,
        locale: 'en-US',
        labels: getVideoExportCoverLabels('en-US'),
      },
      measure,
    );

    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith(
      expect.objectContaining({
        content: {
          title: 'non-empty',
          questions: [{ id: 'q', type: 'single', question: 'Q', options: [] }],
        },
        width: 1920,
        height: 1080,
        locale: 'en-US',
      }),
    );
    expect(probe.measureQuestionList(nonEmpty)).toEqual(measurement);
    expect(probe.measureQuestionList(empty)).toBeNull();
    expect(probe.measureQuestionList(nonQuiz)).toBeNull();
  });

  it('turns measurement rejection into a null lookup for compiler fallback', async () => {
    const source = quiz('failed', [{ id: 'q', type: 'short_answer', question: 'Q' }]);
    const probe = await createQuizLayoutProbe(
      {
        scenes: [source],
        width: 1280,
        height: 720,
        locale: 'zh-CN',
        labels: getVideoExportCoverLabels('zh-CN'),
      },
      vi.fn().mockRejectedValue(new Error('font timeout')),
    );

    expect(probe.measureQuestionList(source)).toBeNull();
  });
});
