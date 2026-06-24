/**
 * Pure, side-effect-free editing operations for the quiz content surface.
 *
 * Two layers live here:
 *   1. A snapshot-based undo/redo history primitive (`QuizEditHistory`),
 *      mirroring the slide surface's `slide-ops` history shape so the
 *      quiz-edit-session store can reuse the same idiom.
 *   2. Structured mutations over `QuizContent` — every helper takes a
 *      `QuizContent` and returns a NEW `QuizContent` (referential change is
 *      the "real edit" signal the EditShell's `surfaceStateEqual` compares).
 *
 * **Option model.** A `QuizOption.value` doubles as the option's displayed
 * badge letter (QuizView renders `opt.value` as the A/B/C chip) AND the key
 * stored in `QuizQuestion.answer`. To keep the displayed letters sequential
 * regardless of insert / delete / reorder while never corrupting `answer`,
 * choice-option mutations round-trip through a position-independent
 * intermediate (`OptionRow { label, correct }`): edits act on rows, then
 * `fromRows` re-derives `value = LETTERS[index]` and rebuilds `answer` from
 * the per-row `correct` flag. Reordering options therefore never needs an
 * explicit answer remap — correctness travels with the row.
 */

import type { QuizContent, QuizQuestion, QuizQuestionType } from '@/lib/types/stage';
import { createElementId } from '@/lib/edit/element-id';

// ---------------------------------------------------------------------------
// History primitive (snapshot-based, mirrors slide-ops shape)
// ---------------------------------------------------------------------------

export interface QuizEditHistory {
  past: QuizContent[];
  present: QuizContent;
  future: QuizContent[];
}

export function createQuizEditHistory(present: QuizContent): QuizEditHistory {
  return { past: [], present, future: [] };
}

/**
 * Fold a new content snapshot in as a fresh undo step. A no-op (identical
 * reference) is dropped so callers can commit unconditionally without
 * polluting the undo stack. Committing clears the redo branch.
 */
export function commitQuizContent(history: QuizEditHistory, next: QuizContent): QuizEditHistory {
  if (next === history.present) return history;
  return { past: [...history.past, history.present], present: next, future: [] };
}

export function undoQuiz(history: QuizEditHistory): QuizEditHistory {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoQuiz(history: QuizEditHistory): QuizEditHistory {
  if (history.future.length === 0) return history;
  const next = history.future[0];
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

// ---------------------------------------------------------------------------
// Option-row intermediate
// ---------------------------------------------------------------------------

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Max options a choice question may hold (A–Z). */
export const MAX_OPTIONS = LETTERS.length;

export interface OptionRow {
  label: string;
  correct: boolean;
}

export function optionLetter(index: number): string {
  return LETTERS[index] ?? `#${index + 1}`;
}

export function toRows(q: QuizQuestion): OptionRow[] {
  const answer = q.answer ?? [];
  return (q.options ?? []).map((o) => ({ label: o.label, correct: answer.includes(o.value) }));
}

/** Re-derive `options` (value = positional letter) + `answer` from rows. */
export function fromRows(rows: OptionRow[]): Pick<QuizQuestion, 'options' | 'answer'> {
  const options = rows.map((r, i) => ({ label: r.label, value: optionLetter(i) }));
  const answer = rows
    .map((r, i) => ({ correct: r.correct, value: optionLetter(i) }))
    .filter((r) => r.correct)
    .map((r) => r.value);
  return { options, answer };
}

// ---------------------------------------------------------------------------
// Question factories
// ---------------------------------------------------------------------------

export function isChoice(type: QuizQuestionType): boolean {
  return type === 'single' || type === 'multiple';
}

/** A new blank question of the given type with sensible defaults. */
export function createBlankQuestion(
  type: QuizQuestionType,
  id = createElementId('q'),
): QuizQuestion {
  if (isChoice(type)) {
    return {
      id,
      type,
      question: '',
      options: [
        { label: '', value: 'A' },
        { label: '', value: 'B' },
      ],
      answer: [],
      points: 1,
    };
  }
  return {
    id,
    type: 'short_answer',
    question: '',
    points: 1,
    hasAnswer: false,
  };
}

// ---------------------------------------------------------------------------
// Question-list mutations
// ---------------------------------------------------------------------------

function mapQuestion(
  content: QuizContent,
  id: string,
  fn: (q: QuizQuestion) => QuizQuestion,
): QuizContent {
  return {
    ...content,
    questions: content.questions.map((q) => (q.id === id ? fn(q) : q)),
  };
}

export function addQuestion(
  content: QuizContent,
  type: QuizQuestionType,
  id?: string,
): QuizContent {
  return { ...content, questions: [...content.questions, createBlankQuestion(type, id)] };
}

export function deleteQuestion(content: QuizContent, id: string): QuizContent {
  return { ...content, questions: content.questions.filter((q) => q.id !== id) };
}

/** Reorder questions to match the given id order. Unknown / missing ids are ignored. */
export function reorderQuestions(content: QuizContent, orderedIds: readonly string[]): QuizContent {
  const byId = new Map(content.questions.map((q) => [q.id, q]));
  const next: QuizQuestion[] = [];
  for (const id of orderedIds) {
    const q = byId.get(id);
    if (q) {
      next.push(q);
      byId.delete(id);
    }
  }
  // Preserve any questions not named in orderedIds (defensive), in original order.
  for (const q of content.questions) if (byId.has(q.id)) next.push(q);
  return { ...content, questions: next };
}

/** Patch scalar question fields (question text, analysis, commentPrompt, points, hasAnswer). */
export function updateQuestion(
  content: QuizContent,
  id: string,
  patch: Partial<
    Pick<QuizQuestion, 'question' | 'analysis' | 'commentPrompt' | 'points' | 'hasAnswer'>
  >,
): QuizContent {
  return mapQuestion(content, id, (q) => ({ ...q, ...patch }));
}

/**
 * Switch a question's type, applying the structural transition:
 *   choice → short_answer : drop options + answer, seed grading fields.
 *   short_answer → choice : seed two blank options, empty answer.
 *   single ↔ multiple     : keep options; collapsing to single keeps only
 *                           the first correct answer.
 */
export function setQuestionType(
  content: QuizContent,
  id: string,
  type: QuizQuestionType,
): QuizContent {
  return mapQuestion(content, id, (q) => {
    if (q.type === type) return q;

    if (!isChoice(type)) {
      // → short_answer
      const { options: _o, answer: _a, ...rest } = q;
      return { ...rest, type: 'short_answer', hasAnswer: q.hasAnswer ?? false };
    }

    if (!isChoice(q.type)) {
      // short_answer → choice
      const { commentPrompt: _c, hasAnswer: _h, ...rest } = q;
      return {
        ...rest,
        type,
        options: [
          { label: '', value: 'A' },
          { label: '', value: 'B' },
        ],
        answer: [],
      };
    }

    // single ↔ multiple: keep options; single keeps at most one correct.
    const answer = type === 'single' ? (q.answer ?? []).slice(0, 1) : (q.answer ?? []);
    return { ...q, type, answer };
  });
}

// ---------------------------------------------------------------------------
// Option mutations (choice questions only; no-op on short_answer)
// ---------------------------------------------------------------------------

function mapRows(
  content: QuizContent,
  id: string,
  fn: (rows: OptionRow[]) => OptionRow[],
): QuizContent {
  return mapQuestion(content, id, (q) => {
    if (!isChoice(q.type)) return q;
    return { ...q, ...fromRows(fn(toRows(q))) };
  });
}

export function addOption(content: QuizContent, id: string): QuizContent {
  return mapRows(content, id, (rows) =>
    rows.length >= MAX_OPTIONS ? rows : [...rows, { label: '', correct: false }],
  );
}

export function deleteOption(content: QuizContent, id: string, index: number): QuizContent {
  return mapRows(content, id, (rows) => rows.filter((_, i) => i !== index));
}

export function updateOptionLabel(
  content: QuizContent,
  id: string,
  index: number,
  label: string,
): QuizContent {
  return mapRows(content, id, (rows) => rows.map((r, i) => (i === index ? { ...r, label } : r)));
}

export function reorderOptions(
  content: QuizContent,
  id: string,
  fromIndex: number,
  toIndex: number,
): QuizContent {
  return mapRows(content, id, (rows) => {
    if (fromIndex === toIndex) return rows;
    if (fromIndex < 0 || fromIndex >= rows.length) return rows;
    if (toIndex < 0 || toIndex >= rows.length) return rows;
    const next = rows.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
  });
}

/**
 * Toggle an option's correctness. For `single`, selecting an option makes it
 * the sole correct answer (radio semantics). For `multiple`, it flips that
 * option independently (checkbox semantics).
 */
export function toggleCorrect(content: QuizContent, id: string, index: number): QuizContent {
  return mapQuestion(content, id, (q) => {
    if (!isChoice(q.type)) return q;
    const rows = toRows(q);
    if (index < 0 || index >= rows.length) return q;
    const next =
      q.type === 'single'
        ? rows.map((r, i) => ({ ...r, correct: i === index }))
        : rows.map((r, i) => (i === index ? { ...r, correct: !r.correct } : r));
    return { ...q, ...fromRows(next) };
  });
}
