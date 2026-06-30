import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizContent } from '@/lib/types/stage';
import { addQuestion, updateQuestion } from '@/components/edit/surfaces/quiz/quiz-edit-ops';

// Mock the canonical stage store so we can assert write-through.
const updateScene = vi.fn();
vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: () => ({ updateScene }) },
}));

const { useQuizEditSession } = await import('@/components/edit/surfaces/quiz/quiz-edit-session');

function makeContent(): QuizContent {
  return {
    type: 'quiz',
    questions: [{ id: 'q1', type: 'single', question: 'Q?', options: [], answer: [], points: 1 }],
  };
}

describe('useQuizEditSession (auto-save to stage store)', () => {
  beforeEach(() => {
    useQuizEditSession.getState().end();
    updateScene.mockClear();
  });

  it('seed adopts a baseline without touching the stage store', () => {
    useQuizEditSession.getState().seed('scene-1', makeContent());
    const { sceneId, history } = useQuizEditSession.getState();
    expect(sceneId).toBe('scene-1');
    expect(history?.past).toEqual([]);
    expect(history?.present.questions[0].id).toBe('q1');
    expect(updateScene).not.toHaveBeenCalled();
  });

  it('commit advances history one step, writes through, and produces a NEW content ref', () => {
    useQuizEditSession.getState().seed('scene-1', makeContent());
    const before = useQuizEditSession.getState().history!.present;
    useQuizEditSession.getState().commit(addQuestion(before, 'multiple', 'q2'));
    const { history } = useQuizEditSession.getState();
    expect(history?.past).toHaveLength(1);
    expect(history?.present).not.toBe(before); // ref change → surfaceStateEqual fires
    expect(history?.present.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(updateScene).toHaveBeenCalledWith(
      'scene-1',
      expect.objectContaining({ content: history!.present }),
    );
  });

  it('commitText with the same key coalesces into one undo step (every keystroke writes through)', () => {
    useQuizEditSession.getState().seed('scene-1', makeContent());
    const s = () => useQuizEditSession.getState();
    s().commitText(updateQuestion(s().history!.present, 'q1', { question: 'C' }), 'q1:question');
    s().commitText(updateQuestion(s().history!.present, 'q1', { question: 'Ca' }), 'q1:question');
    s().commitText(updateQuestion(s().history!.present, 'q1', { question: 'Cap' }), 'q1:question');
    expect(s().history?.past).toHaveLength(1); // one burst → one step
    expect(s().history?.present.questions[0].question).toBe('Cap');
    expect(updateScene).toHaveBeenCalledTimes(3); // but all three persisted
  });

  it('commitText with a different key starts a new undo step', () => {
    useQuizEditSession.getState().seed('scene-1', makeContent());
    const s = () => useQuizEditSession.getState();
    s().commitText(updateQuestion(s().history!.present, 'q1', { question: 'X' }), 'q1:question');
    s().commitText(updateQuestion(s().history!.present, 'q1', { analysis: 'Y' }), 'q1:analysis');
    expect(s().history?.past).toHaveLength(2);
  });

  it('a discrete commit closes the current text burst', () => {
    useQuizEditSession.getState().seed('scene-1', makeContent());
    const s = () => useQuizEditSession.getState();
    s().commitText(updateQuestion(s().history!.present, 'q1', { question: 'X' }), 'q1:question');
    s().commit(addQuestion(s().history!.present, 'single', 'q2'));
    // Another text edit with the SAME key must NOT merge into the pre-commit burst.
    s().commitText(updateQuestion(s().history!.present, 'q1', { question: 'XY' }), 'q1:question');
    expect(s().history?.past).toHaveLength(3);
  });

  it('undo / redo write the restored snapshot through to the stage store', () => {
    useQuizEditSession.getState().seed('scene-1', makeContent());
    const s = () => useQuizEditSession.getState();
    const base = s().history!.present;
    s().commit(addQuestion(base, 'single', 'q2'));
    updateScene.mockClear();
    s().undo();
    expect(s().history?.present).toBe(base);
    expect(updateScene).toHaveBeenLastCalledWith(
      'scene-1',
      expect.objectContaining({ content: base }),
    );
    s().redo();
    expect(s().history?.present.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
  });
});
