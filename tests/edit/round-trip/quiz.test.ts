import { describe, it, expect } from 'vitest';
import type { ManifestScene } from '@/lib/export/classroom-zip-types';
import type { QuizContent } from '@/lib/types/stage';
import {
  addOption,
  addQuestion,
  setQuestionType,
  toggleCorrect,
  updateOptionLabel,
  updateQuestion,
} from '@/components/edit/surfaces/quiz/quiz-edit-ops';

/**
 * Round-trip gate for the quiz surface (issue #657, design principle #1).
 *
 * A quiz scene is NOT a PPTX citizen (`use-export-pptx` filters to slide
 * scenes). Its export target is the classroom ZIP manifest, which serializes
 * the full `scene.content` to JSON on export (`use-export-classroom`) and
 * reads it back verbatim on import (`use-import-classroom`). The gate: an
 * edited `QuizContent` survives that JSON round-trip with every field intact
 * and no non-serializable values leaking in.
 */

/** Mirror the manifest's JSON serialize → deserialize boundary. */
function manifestRoundTrip(content: QuizContent): QuizContent {
  const scene: ManifestScene = { type: 'quiz', title: 'Quiz', order: 1, content };
  const json = JSON.stringify(scene);
  const parsed = JSON.parse(json) as ManifestScene;
  return parsed.content as QuizContent;
}

function buildEditedQuiz(): QuizContent {
  let c: QuizContent = { type: 'quiz', questions: [] };
  // A multiple-choice question with two correct answers.
  c = addQuestion(c, 'multiple', 'q1');
  c = updateQuestion(c, 'q1', {
    question: 'Which are prime?',
    analysis: '2 and 3 are prime.',
    points: 2,
  });
  c = addOption(c, 'q1'); // now A,B,C
  c = updateOptionLabel(c, 'q1', 0, '2');
  c = updateOptionLabel(c, 'q1', 1, '4');
  c = updateOptionLabel(c, 'q1', 2, '3');
  c = toggleCorrect(c, 'q1', 0); // 2 correct
  c = toggleCorrect(c, 'q1', 2); // 3 correct
  // A short-answer question with grading guidance.
  c = addQuestion(c, 'short_answer', 'q2');
  c = updateQuestion(c, 'q2', {
    question: 'Explain primality.',
    commentPrompt: 'Mention divisors.',
  });
  c = setQuestionType(c, 'q2', 'short_answer'); // no-op, but exercises the path
  return c;
}

describe('quiz classroom-manifest round-trip', () => {
  it('survives JSON serialize → deserialize with all fields intact', () => {
    const edited = buildEditedQuiz();
    const restored = manifestRoundTrip(edited);
    expect(restored).toEqual(edited);
  });

  it('preserves multiple-choice answer keys and option letters', () => {
    const restored = manifestRoundTrip(buildEditedQuiz());
    const q1 = restored.questions.find((q) => q.id === 'q1')!;
    expect(q1.options?.map((o) => o.value)).toEqual(['A', 'B', 'C']);
    expect(q1.answer).toEqual(['A', 'C']); // "2" and "3"
    expect(q1.points).toBe(2);
  });

  it('preserves short-answer grading fields', () => {
    const restored = manifestRoundTrip(buildEditedQuiz());
    const q2 = restored.questions.find((q) => q.id === 'q2')!;
    expect(q2.type).toBe('short_answer');
    expect(q2.commentPrompt).toBe('Mention divisors.');
    expect(q2.options).toBeUndefined();
  });

  it('introduces no non-JSON-serializable values (no data lost to JSON)', () => {
    const edited = buildEditedQuiz();
    // If any field were a function / undefined-in-array / Map, stringify would
    // drop or mangle it and the deep-equal above would already fail; this
    // asserts the serialized form is itself stable (idempotent re-parse).
    const once = JSON.stringify(edited);
    const twice = JSON.stringify(JSON.parse(once));
    expect(twice).toBe(once);
  });
});
