import { describe, it, expect, vi } from 'vitest';
import {
  completeSummaryForScenes,
  pendingCompleteSummary,
  readSceneQuizAnswers,
  summarizeScenes,
} from '@/lib/classroom/complete-summary';
import type { Scene, QuizQuestion } from '@/lib/types/stage';

function slide(id: string, order: number): Scene {
  return {
    id,
    stageId: 's1',
    type: 'slide',
    title: id,
    order,
    content: { type: 'slide', canvas: {} as never },
  };
}

function quizScene(id: string, order: number, questions: QuizQuestion[]): Scene {
  return {
    id,
    stageId: 's1',
    type: 'quiz',
    title: id,
    order,
    content: { type: 'quiz', questions },
  };
}

function interactive(id: string, order: number): Scene {
  return {
    id,
    stageId: 's1',
    type: 'interactive',
    title: id,
    order,
    content: { type: 'interactive', url: 'about:blank' },
  };
}

const choiceQ = (id: string, answer: string[]): QuizQuestion => ({
  id,
  type: 'single',
  question: id,
  options: [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ],
  answer,
  hasAnswer: true,
  points: 1,
});

describe('summarizeScenes', () => {
  it('skips a legacy scene without stageId before loading runtime answers', async () => {
    const { stageId: _stageId, ...legacy } = quizScene('legacy', 0, [choiceQ('qa', ['a'])]);
    const load = vi.fn();

    await expect(readSceneQuizAnswers(legacy, load)).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it('shows the new classroom baseline while its async summary is pending', () => {
    const previousScenes = [quizScene('old', 0, [choiceQ('old-q', ['a'])])];
    const nextScenes = [slide('new-1', 0), slide('new-2', 1)];
    const previous = {
      scenes: previousScenes,
      summary: { countsByType: { quiz: 1 }, quiz: { correct: 1, total: 1, pct: 100 } },
    };

    expect(completeSummaryForScenes(nextScenes, previous)).toEqual({
      countsByType: { slide: 2 },
      quiz: null,
    });
  });

  it('seeds a new completion page with its synchronous scene-count baseline', () => {
    const scenes = [slide('new-1', 0), slide('new-2', 1), interactive('new-3', 2)];

    expect(pendingCompleteSummary(scenes)).toEqual({
      countsByType: { slide: 2, interactive: 1 },
      quiz: null,
    });
  });

  it('counts scenes by type and omits zeros', async () => {
    const scenes = [slide('s1', 0), slide('s2', 1), interactive('i1', 2)];
    const result = await summarizeScenes(scenes, async () => ({}));
    expect(result.countsByType).toEqual({ slide: 2, interactive: 1 });
    expect(result.quiz).toBeNull();
  });

  it('returns null quiz when no quiz scenes exist', async () => {
    const result = await summarizeScenes([slide('s1', 0)], async () => ({}));
    expect(result.quiz).toBeNull();
  });

  it('aggregates quiz answers across multiple quiz scenes', async () => {
    const scenes = [
      quizScene('q1', 0, [choiceQ('qa', ['a']), choiceQ('qb', ['b'])]),
      quizScene('q2', 1, [choiceQ('qc', ['a'])]),
    ];
    const answers: Record<string, Record<string, string | string[]>> = {
      q1: { qa: 'a', qb: 'a' },
      q2: { qc: 'a' },
    };
    const result = await summarizeScenes(scenes, async (sceneId) => answers[sceneId] ?? {});
    expect(result.quiz).toEqual({ correct: 2, total: 3, pct: Math.round((2 / 3) * 100) });
    expect(result.countsByType.quiz).toBe(2);
  });

  it('returns null quiz when quiz scenes exist but have no gradeable questions', async () => {
    const saOnly = quizScene('q1', 0, [
      {
        id: 'sa',
        type: 'short_answer',
        question: 'x',
        answer: [],
        hasAnswer: false,
      },
    ]);
    const result = await summarizeScenes([saOnly], async () => ({}));
    expect(result.quiz).toBeNull();
    expect(result.countsByType.quiz).toBe(1);
  });

  it('treats missing answers as incorrect (not skipped)', async () => {
    const scenes = [quizScene('q1', 0, [choiceQ('qa', ['a']), choiceQ('qb', ['b'])])];
    const result = await summarizeScenes(scenes, async () => ({}));
    expect(result.quiz).toEqual({ correct: 0, total: 2, pct: 0 });
  });

  it('omits quiz scenes whose authoritative answers are unavailable', async () => {
    const scenes = [
      quizScene('unavailable', 0, [choiceQ('qa', ['a'])]),
      quizScene('available', 1, [choiceQ('qb', ['b'])]),
    ];

    const result = await summarizeScenes(scenes, async (sceneId) => {
      if (sceneId === 'unavailable') throw new Error('storage unavailable');
      return { qb: 'b' };
    });

    expect(result.quiz).toEqual({ correct: 1, total: 1, pct: 100 });
  });
});
