import { describe, it, expect } from 'vitest';
import { summarizeScenes } from '@/lib/classroom/complete-summary';
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
  it('counts scenes by type and omits zeros', () => {
    const scenes = [slide('s1', 0), slide('s2', 1), interactive('i1', 2)];
    const result = summarizeScenes(scenes, () => ({}));
    expect(result.countsByType).toEqual({ slide: 2, interactive: 1 });
    expect(result.quiz).toBeNull();
  });

  it('returns null quiz when no quiz scenes exist', () => {
    const result = summarizeScenes([slide('s1', 0)], () => ({}));
    expect(result.quiz).toBeNull();
  });

  it('aggregates quiz answers across multiple quiz scenes', () => {
    const scenes = [
      quizScene('q1', 0, [choiceQ('qa', ['a']), choiceQ('qb', ['b'])]),
      quizScene('q2', 1, [choiceQ('qc', ['a'])]),
    ];
    const answers: Record<string, Record<string, string | string[]>> = {
      q1: { qa: 'a', qb: 'a' },
      q2: { qc: 'a' },
    };
    const result = summarizeScenes(scenes, (sceneId) => answers[sceneId] ?? {});
    expect(result.quiz).toEqual({ correct: 2, total: 3, pct: Math.round((2 / 3) * 100) });
    expect(result.countsByType.quiz).toBe(2);
  });

  it('returns null quiz when quiz scenes exist but have no gradeable questions', () => {
    const saOnly = quizScene('q1', 0, [
      {
        id: 'sa',
        type: 'short_answer',
        question: 'x',
        answer: [],
        hasAnswer: false,
      },
    ]);
    const result = summarizeScenes([saOnly], () => ({}));
    expect(result.quiz).toBeNull();
    expect(result.countsByType.quiz).toBe(1);
  });

  it('treats missing answers as incorrect (not skipped)', () => {
    const scenes = [quizScene('q1', 0, [choiceQ('qa', ['a']), choiceQ('qb', ['b'])])];
    const result = summarizeScenes(scenes, () => ({}));
    expect(result.quiz).toEqual({ correct: 0, total: 2, pct: 0 });
  });
});
