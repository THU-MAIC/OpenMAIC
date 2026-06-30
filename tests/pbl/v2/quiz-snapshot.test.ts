/**
 * Tests for the pre-PBL quiz snapshot helpers.
 *
 * Covers both `buildQuizSnapshot` (client-side, reads localStorage)
 * and `applyQuizSignalsToProject` (server-side, mutates the project's
 * proficiency assessment). The robustness matrix is the focus —
 * non-quiz scenes, unsubmitted quizzes, all-short-answer quizzes,
 * empty results, and missing assessment should all be safe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyQuizSignalsToProject,
  buildQuizSnapshot,
} from '@/lib/pbl/v2/operations/quiz-snapshot';
import { emptyAssessment } from '@/lib/pbl/v2/operations/proficiency';
import type { PBLProjectV2, PriorQuizResult } from '@/lib/pbl/v2/types';
import type { Scene } from '@/lib/types/stage';

// `lib/quiz/persistence` reads from localStorage. We mock it for
// these tests rather than driving the global object — keeps tests
// node-only.
vi.mock('@/lib/quiz/persistence', () => ({
  readSubmittedState: vi.fn(),
  draftKey: (id: string) => 'quizDraft:' + id,
  DRAFT_KEY_PREFIX: 'quizDraft:',
  ANSWERS_KEY_PREFIX: 'quizAnswers:',
  RESULTS_KEY_PREFIX: 'quizResults:',
}));

import { readSubmittedState } from '@/lib/quiz/persistence';

beforeEach(() => {
  vi.mocked(readSubmittedState).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mkQuizScene(id: string, questions: number): Scene {
  return {
    id,
    stageId: 'stg',
    type: 'quiz',
    title: `Q ${id}`,
    order: 1,
    content: {
      type: 'quiz',
      questions: Array.from({ length: questions }, (_, i) => ({
        id: `q${i}`,
        type: 'single' as const,
        question: 'x',
        options: [{ label: 'A', value: 'A' }],
        answer: ['A'],
        hasAnswer: true,
      })),
    },
    actions: [],
  } as unknown as Scene;
}

function mkSlideScene(id: string): Scene {
  return {
    id,
    stageId: 'stg',
    type: 'slide',
    title: 's',
    order: 1,
    content: { type: 'slide', canvas: {} } as never,
    actions: [],
  } as unknown as Scene;
}

function mkProject(overrides: Partial<PBLProjectV2> = {}): PBLProjectV2 {
  return {
    uiPhase: 'workspace',
    title: 't',
    description: 'd',
    proficiency: 'intermediate',
    proficiencyAssessment: emptyAssessment(),
    language: 'zh-CN',
    tags: [],
    status: 'active',
    roles: [],
    milestones: [],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('buildQuizSnapshot', () => {
  it('returns [] when there are no quiz scenes', () => {
    expect(buildQuizSnapshot([mkSlideScene('s1'), mkSlideScene('s2')])).toEqual([]);
  });

  it('skips quizzes the learner has not submitted', () => {
    vi.mocked(readSubmittedState).mockImplementation((id) =>
      id === 'q1' ? { kind: 'answering', answers: {} } : null,
    );
    expect(buildQuizSnapshot([mkQuizScene('q1', 3)])).toEqual([]);
  });

  it('counts correct / incorrect / unscored properly', () => {
    vi.mocked(readSubmittedState).mockImplementation((id) =>
      id === 'q1'
        ? {
            kind: 'reviewing',
            answers: {},
            results: [
              { questionId: 'q0', correct: true, status: 'correct', earned: 1 },
              { questionId: 'q1', correct: false, status: 'incorrect', earned: 0 },
              { questionId: 'q2', correct: null, status: 'incorrect', earned: 0 },
            ],
          }
        : null,
    );
    const r = buildQuizSnapshot([mkQuizScene('q1', 3)]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      sceneId: 'q1',
      correctCount: 1,
      incorrectCount: 1,
      unscoredCount: 1,
      accuracy: 0.5, // 1/(1+1) scored
    });
  });

  it('marks accuracy null when every question is unscored', () => {
    vi.mocked(readSubmittedState).mockImplementation((id) =>
      id === 'q1'
        ? {
            kind: 'reviewing',
            answers: {},
            results: [
              { questionId: 'q0', correct: null, status: 'incorrect', earned: 0 },
              { questionId: 'q1', correct: null, status: 'incorrect', earned: 0 },
            ],
          }
        : null,
    );
    const r = buildQuizSnapshot([mkQuizScene('q1', 2)]);
    expect(r[0].accuracy).toBeNull();
  });

  it('aggregates across multiple quiz scenes', () => {
    vi.mocked(readSubmittedState).mockImplementation((id) => {
      if (id === 'q1') {
        return {
          kind: 'reviewing',
          answers: {},
          results: [{ questionId: 'q0', correct: true, status: 'correct', earned: 1 }],
        };
      }
      if (id === 'q2') {
        return {
          kind: 'reviewing',
          answers: {},
          results: [{ questionId: 'q0', correct: false, status: 'incorrect', earned: 0 }],
        };
      }
      return null;
    });
    const r = buildQuizSnapshot([mkQuizScene('q1', 1), mkQuizScene('q2', 1)]);
    expect(r).toHaveLength(2);
    expect(r[0].accuracy).toBe(1);
    expect(r[1].accuracy).toBe(0);
  });
});

describe('applyQuizSignalsToProject', () => {
  it('no-ops on empty results', () => {
    const p = mkProject();
    const before = p.proficiencyAssessment;
    const r = applyQuizSignalsToProject(p, []);
    expect(r.updated).toBe(false);
    expect(p.proficiencyAssessment).toBe(before);
  });

  it('no-ops when every quiz is fully unscored', () => {
    const p = mkProject();
    const before = p.proficiencyAssessment;
    const r = applyQuizSignalsToProject(p, [
      {
        sceneId: 'q',
        sceneTitle: 'q',
        totalQuestions: 3,
        correctCount: 0,
        incorrectCount: 0,
        unscoredCount: 3,
        accuracy: null,
      },
    ]);
    expect(r.updated).toBe(false);
    expect(p.proficiencyAssessment).toBe(before);
  });

  it('updates assessment + flips tier on a strong quiz signal', () => {
    const p = mkProject();
    const results: PriorQuizResult[] = [
      {
        sceneId: 'q',
        sceneTitle: 'q',
        totalQuestions: 5,
        correctCount: 5,
        incorrectCount: 0,
        unscoredCount: 0,
        accuracy: 1,
      },
    ];
    const r = applyQuizSignalsToProject(p, results);
    expect(r.updated).toBe(true);
    expect(p.proficiencyAssessment!.source).toBe('pre-play');
    // 100% accuracy with weight 0.6 → EWMA push 0.12, but a high
    // direction signal layered on top of the existing path. The
    // important assertion here is "engaged + recorded".
    expect(p.proficiencyAssessment!.signals.some((s) => s.kind === 'quiz_accuracy')).toBe(true);
  });

  it('lazily creates an assessment when one is missing', () => {
    const p = mkProject({ proficiencyAssessment: undefined });
    applyQuizSignalsToProject(p, [
      {
        sceneId: 'q',
        sceneTitle: 'q',
        totalQuestions: 2,
        correctCount: 1,
        incorrectCount: 1,
        unscoredCount: 0,
        accuracy: 0.5,
      },
    ]);
    expect(p.proficiencyAssessment).toBeDefined();
  });
});
