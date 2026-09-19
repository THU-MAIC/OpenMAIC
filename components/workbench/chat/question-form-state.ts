'use client';

/**
 * The composer takeover form's rules — `ask_user` as a questionnaire.
 *
 * When a question is waiting, the composer does not grow a panel above itself;
 * it BECOMES the form (see `question-form.tsx`). That makes the keyboard the
 * primary input device for a moment — the whole point of a takeover is that the
 * hands are already on the keys — so every navigation rule here is a pure
 * function, testable without a DOM, in the same split as `composer-send-state.ts`
 * and `question-card-state.ts` (which still owns everything the transcript card
 * and the form share: the mode, the lock, the multi-select join).
 *
 * The row list, the highlight and the answer text are three separate facts on
 * purpose:
 *
 *  - ROWS are the envelope's options plus the always-last "other…" row. The free-text
 *    channel is a row, not a sentence pointing somewhere else, because the box it
 *    used to point at is now this form.
 *  - HIGHLIGHT is one index over rows PLUS one past the end, which is submit. That
 *    is what makes "Enter on the submit button submits" a case of one rule rather
 *    than a second key handler.
 *  - ANSWER TEXT is derived from the picks every time. Submit is enabled iff that
 *    text is non-empty, so "disabled when nothing is picked or filled" needs no
 *    separate validity flag that could disagree with what would actually be sent.
 */
import { useMemo, useState } from 'react';
import type { ChatNode, QuestionOption } from '@/lib/workbench/session-store';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';
import {
  isQuestionLocked,
  questionMode,
  togglePicked,
  multiAnswerSeparator,
} from './question-card-state';

/**
 * The free-text row's label, and what the keyboard hint calls it — in the
 * default locale, for tests and for callers with no translator to hand. The
 * rendered row reads `t('workbench.question.other')` itself.
 */
export const OTHER_ROW_LABEL = defaultWorkbenchTranslator('workbench.question.other');

/**
 * What the composer should BE right now: a question's form, or nothing (its
 * ordinary self).
 *
 * The whole dismiss/revive state machine is this one line, and the reason it fits
 * in one line is that "dismissed" is remembered as a NODE KEY rather than a
 * boolean. A new question carries a new key, so it takes the composer over on its
 * own; reviving is clearing the key; and there is no combination of the two
 * values that means "the form of a question that is no longer waiting".
 *
 *   pending=null                     → the composer, always (nothing is waiting)
 *   pending=q, dismissedKey=null     → q's form
 *   pending=q, dismissedKey=q.key    → the composer (waved off, question intact)
 *   pending=q2, dismissedKey=q1.key  → q2's form (a NEW question is a new ask)
 */
export function composerTakeover(input: {
  pending: ChatNode | null;
  dismissedKey: string | null;
}): ChatNode | null {
  const { pending, dismissedKey } = input;
  if (!pending) return null;
  return pending.key === dismissedKey ? null : pending;
}

/**
 * A navigable row. `other` carries no id: the free-text answer is tracked as its
 * own boolean and string, never as a synthetic option id in the picked set —
 * an envelope is free to name an option anything, and a sentinel id in that set
 * would be one collision away from sending the sentinel as an answer.
 */
export type QuestionFormRow =
  | { readonly kind: 'option'; readonly id: string; readonly label: string }
  | { readonly kind: 'other' };

/** What is selected right now: envelope option ids, plus whether the "other" row is on. */
export interface QuestionFormPicks {
  readonly picked: readonly string[];
  readonly otherPicked: boolean;
}

export const NO_PICKS: QuestionFormPicks = { picked: [], otherPicked: false };

/**
 * The rows for one question. Empty for an open question: there is nothing to
 * navigate, and the form degrades to a title plus a multi-line box.
 */
export function questionFormRows(node: ChatNode): QuestionFormRow[] {
  const options = node.questionOptions ?? [];
  if (options.length === 0) return [];
  return [
    ...options.map((option): QuestionFormRow => ({ kind: 'option', ...option })),
    { kind: 'other' },
  ];
}

/**
 * Pick an envelope option. Single choice REPLACES (radio semantics, and it drops
 * the "other" pick — one answer means one answer); multi toggles, and leaves the
 * "other" pick alone because a checkbox list can carry both canned picks and a
 * written addition.
 */
export function pickOption(
  state: QuestionFormPicks,
  id: string,
  multi: boolean,
): QuestionFormPicks {
  if (!multi) return { picked: [id], otherPicked: false };
  return { picked: togglePicked(state.picked, id), otherPicked: state.otherPicked };
}

/**
 * Pick the "other" row. Single choice selects it and clears the canned picks;
 * a second single-choice click does NOT unselect it (a radio cannot be emptied
 * by clicking it again), while multi toggles it like any other box.
 */
export function pickOther(state: QuestionFormPicks, multi: boolean): QuestionFormPicks {
  if (!multi) return { picked: [], otherPicked: true };
  return { picked: state.picked, otherPicked: !state.otherPicked };
}

/**
 * The message these picks send.
 *
 * ENVELOPE ORDER for the canned labels (the agent listed them in the order it
 * wants them read), and the written answer always last — the same place its row
 * sits in the list. An empty string means "nothing to send", which is exactly
 * the condition submit is disabled on: an unpicked question, or the "other" box
 * with a blank answer.
 */
export function formAnswerText(input: {
  mode: 'open' | 'single' | 'multi';
  options: readonly QuestionOption[];
  picks: QuestionFormPicks;
  otherText: string;
  openText: string;
  t?: WorkbenchTranslator;
}): string {
  const { mode, options, picks, otherText, openText, t = defaultWorkbenchTranslator } = input;
  if (mode === 'open') return openText.trim();
  const labels = options.filter((o) => picks.picked.includes(o.id)).map((o) => o.label);
  const written = picks.otherPicked ? otherText.trim() : '';
  // Single choice can only ever produce one part, so one join serves both modes.
  return (written ? [...labels, written] : labels).join(multiAnswerSeparator(t));
}

/**
 * Highlight movement: CLAMPED, not wrapping. ↑ on the first option must not
 * teleport to submit at the other end of the form — in a five-row questionnaire
 * that reads as the highlight vanishing.
 *
 * `rowCount` is the number of rows; index `rowCount` is submit, which is why the
 * upper bound is `rowCount` and not `rowCount - 1`.
 */
export function moveHighlight(current: number, delta: number, rowCount: number): number {
  const next = current + delta;
  if (next < 0) return 0;
  if (next > rowCount) return rowCount;
  return next;
}

/**
 * Which row a digit picks: 1-9 map to the first nine rows (the "other" row
 * included — it is a row like any other). Anything past nine has no shortcut;
 * that is a real limit, not a bug, and the badges keep counting so the numbering
 * does not lie about which row is which.
 */
export function quickPickIndex(key: string, rowCount: number): number | null {
  if (key.length !== 1 || key < '1' || key > '9') return null;
  const index = Number(key) - 1;
  return index < rowCount ? index : null;
}

/** Whether the event's target is a text box, and whether Enter belongs to it. */
export type QuestionFormEditing = false | 'line' | 'multiline';

/** `event.target.tagName` → editing kind. The "other" box is a line; the open answer is not. */
export function editingKindFor(tagName: string): QuestionFormEditing {
  const tag = tagName.toUpperCase();
  if (tag === 'TEXTAREA') return 'multiline';
  if (tag === 'INPUT') return 'line';
  return false;
}

export type QuestionFormKeyAction =
  | { readonly type: 'none' }
  | { readonly type: 'move'; readonly index: number }
  | { readonly type: 'activate'; readonly index: number }
  | { readonly type: 'submit' }
  | { readonly type: 'dismiss' };

/**
 * One key, one action — the whole keyboard contract of the form.
 *
 * The rule that earns this function its own tests is the editing guard: while
 * the caret is in the "other" box (or an open question's textarea), the digits
 * are TEXT. A form that quick-picks row 3 because the user typed "3" in a
 * sentence would be unusable, so nothing but Enter and Escape is interpreted
 * there.
 *
 *  Escape          → dismiss, from anywhere, typing included (the way out is
 *                    never behind a focus state).
 *  ⌘/Ctrl+Enter    → submit, from anywhere, same reason.
 *  Enter           → in a multi-line box it is a newline; in the "other" line
 *                    it submits (single-line boxes have nothing else to do with
 *                    it); otherwise it CONFIRMS the highlight — which is submit
 *                    when the highlight has moved past the last row.
 *  ↑ ↓             → move the highlight (clamped).
 *  1-9             → confirm that row directly, i.e. the digit is the fast path
 *                    for "highlight it, then Enter".
 *
 * `composing` is the IME guard: a Chinese candidate list swallows Enter, and
 * committing a candidate must not submit the form.
 */
export function questionFormKeyAction(input: {
  key: string;
  editing: QuestionFormEditing;
  modifier: boolean;
  composing?: boolean;
  highlight: number;
  rowCount: number;
}): QuestionFormKeyAction {
  const { key, editing, modifier, composing = false, highlight, rowCount } = input;
  if (key === 'Escape') return { type: 'dismiss' };
  if (composing) return { type: 'none' };
  if (key === 'Enter') {
    if (modifier) return { type: 'submit' };
    if (editing === 'multiline') return { type: 'none' };
    if (editing === 'line') return { type: 'submit' };
    return highlight >= rowCount ? { type: 'submit' } : { type: 'activate', index: highlight };
  }
  // Typing is typing: no quick-pick, no highlight movement.
  if (editing !== false) return { type: 'none' };
  if (key === 'ArrowDown') return { type: 'move', index: moveHighlight(highlight, 1, rowCount) };
  if (key === 'ArrowUp') return { type: 'move', index: moveHighlight(highlight, -1, rowCount) };
  const quick = quickPickIndex(key, rowCount);
  if (quick !== null) return { type: 'activate', index: quick };
  return { type: 'none' };
}

/**
 * The form's state, over the same send path as everything else.
 *
 * `select` is what a MOUSE does — it picks, and nothing else. `activate` is what
 * Enter and the digits do: pick, and on a single-choice row send immediately,
 * because confirm is the verb those keys are bound to. That asymmetry is
 * deliberate: a click that sent the moment it landed would make the submit
 * button decoration in single-choice mode, and a keyboard that needed two Enters
 * to answer a radio list would make the takeover slower than the box it
 * replaced.
 *
 * `sending` covers the POST window only. The durable answer is the user message
 * the send produces; the fold's `questionAnswered` retires the whole form the
 * moment its event arrives, so on success the flag is deliberately never cleared
 * (clearing it would flash the rows live again on a form that is about to go).
 */
export function useQuestionForm(
  node: ChatNode,
  onAnswer?: (text: string) => Promise<boolean>,
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
): {
  mode: 'open' | 'single' | 'multi';
  rows: QuestionFormRow[];
  picks: QuestionFormPicks;
  isPicked: (index: number) => boolean;
  highlight: number;
  setHighlight: (index: number) => void;
  otherText: string;
  setOtherText: (text: string) => void;
  openText: string;
  setOpenText: (text: string) => void;
  locked: boolean;
  answerText: string;
  canSubmit: boolean;
  /** Mouse: pick this row. */
  select: (index: number) => void;
  /** Keyboard: confirm this row (single choice sends; past the last row is submit). */
  activate: (index: number) => void;
  submit: () => void;
} {
  const mode = questionMode(node);
  const options = node.questionOptions ?? [];
  const rows = useMemo(() => questionFormRows(node), [node]);
  const [picks, setPicks] = useState<QuestionFormPicks>(NO_PICKS);
  const [highlight, setHighlight] = useState(0);
  const [otherText, setOtherText] = useState('');
  const [openText, setOpenText] = useState('');
  const [sending, setSending] = useState(false);

  const locked = isQuestionLocked({
    answered: Boolean(node.questionAnswered),
    sending,
    canSend: Boolean(onAnswer),
  });
  const answerText = formAnswerText({ mode, options, picks, otherText, openText, t });

  const send = (text: string) => {
    if (locked || !onAnswer || !text) return;
    setSending(true);
    void onAnswer(text).then((ok) => {
      if (!ok) setSending(false);
    });
  };

  const pick = (index: number): QuestionFormPicks | null => {
    const row = rows[index];
    if (!row) return null;
    const next =
      row.kind === 'other'
        ? pickOther(picks, mode === 'multi')
        : pickOption(picks, row.id, mode === 'multi');
    setPicks(next);
    setHighlight(index);
    return next;
  };

  return {
    mode,
    rows,
    picks,
    isPicked: (index) => {
      const row = rows[index];
      if (!row) return false;
      return row.kind === 'other' ? picks.otherPicked : picks.picked.includes(row.id);
    },
    highlight,
    setHighlight: (index) => {
      if (locked) return;
      setHighlight(index);
    },
    otherText,
    setOtherText,
    openText,
    setOpenText,
    locked,
    answerText,
    canSubmit: !locked && answerText.length > 0,
    select: (index) => {
      if (locked) return;
      pick(index);
    },
    activate: (index) => {
      if (locked) return;
      // Past the last row is submit — one highlight space, one Enter.
      if (index >= rows.length) {
        send(answerText);
        return;
      }
      const next = pick(index);
      // A single-choice canned row IS the answer. The "other" row never sends on
      // confirm: there is a box to fill first, and the focus lands in it.
      if (next && mode === 'single' && rows[index]?.kind === 'option') {
        send(formAnswerText({ mode, options, picks: next, otherText, openText, t }));
      }
    },
    submit: () => send(answerText),
  };
}
