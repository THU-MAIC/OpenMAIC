'use client';

/**
 * The question card's rules, as pure functions, plus the one hook the question
 * surfaces share.
 *
 * The same folded question appears TWICE — as a row in the timeline
 * (`question-card.tsx`) and, while it is unanswered, as the form the composer
 * turns into (`question-form.tsx`). Their geometry differs on purpose; the facts
 * they read must not, so the mode, the lock and the multi-select join live here
 * and both call them. (The form's own navigation state — highlight, picks,
 * free-text row — lives in `question-form-state.ts`, because none of it means
 * anything to a transcript row.)
 *
 * Everything else is a pure function: what shape this envelope is, whether the
 * controls are live, what text a set of picks becomes, which question the
 * composer should be showing — all testable without a DOM (the same split as
 * `composer-send-state.ts` / `tool-group-state.ts`).
 */
import { useState } from 'react';
import type { ChatNode, QuestionOption } from '@/lib/workbench/session-store';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';

/**
 * What kind of question this is. Driven by the envelope alone:
 *
 *   open   — no options; the answer is free text (the form degrades to one box).
 *   single — options, one pick, and the confirming keystroke IS the send.
 *   multi  — options, several picks, one message.
 *
 * `multiSelect` with an empty option list is `open`, not `multi`: there is
 * nothing to select, so the only honest shape is the one the payload describes.
 */
export function questionMode(node: ChatNode): 'open' | 'single' | 'multi' {
  const options = node.questionOptions ?? [];
  if (options.length === 0) return 'open';
  return node.questionMultiSelect ? 'multi' : 'single';
}

/**
 * Whether the card's controls are dead.
 *
 * `answered` is the fold's durable fact (a user message landed below the card);
 * `sending` covers the POST window before that message's event arrives; no send
 * path at all means the host cannot post anything, so the options render as the
 * record of what was offered rather than as an action that cannot happen.
 */
export function isQuestionLocked(input: {
  answered: boolean;
  sending: boolean;
  canSend: boolean;
}): boolean {
  return input.answered || input.sending || !input.canSend;
}

/** Toggle one option id in a multi-select set, preserving click order. */
export function togglePicked(picked: readonly string[], id: string): string[] {
  return picked.includes(id) ? picked.filter((current) => current !== id) : [...picked, id];
}

/**
 * How several picked labels become one message. Locale-scoped: the answer lands
 * in the user's own bubble, so it reads with the CJK enumeration comma in
 * Chinese and "A, B" elsewhere.
 */
export function multiAnswerSeparator(t: WorkbenchTranslator): string {
  return t('workbench.question.multiAnswerSeparator');
}

/**
 * The message a set of picks sends.
 *
 * ENVELOPE ORDER, not click order: the agent listed the options in the order it
 * wants them read, and the answer should read the same way whichever order the
 * user tapped them in. Ids the envelope does not contain are ignored — the
 * answer can only ever be built from what was actually offered.
 */
export function answerTextFor(
  options: readonly QuestionOption[],
  picked: readonly string[],
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
): string {
  return options
    .filter((option) => picked.includes(option.id))
    .map((option) => option.label)
    .join(multiAnswerSeparator(t));
}

/**
 * The card's guidance, and only where it earns its line.
 *
 * Multi-select has to say that picking is not yet sending. Nothing else does: a
 * single-choice card explains itself by having buttons, an answered card has
 * nothing left to explain, and an OPEN question no longer points at "the box
 * below" — that box has become the question's own form, so the sentence would be
 * describing something that is not there.
 */
export function questionHint(
  node: ChatNode,
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
): string | null {
  if (node.questionAnswered) return null;
  return questionMode(node) === 'multi' ? t('workbench.question.multiHint') : null;
}

/**
 * The question the composer should be showing: the newest one still waiting.
 *
 * "Newest" rather than "the only one" because the log can hold several — a
 * crash-retried run can re-ask, and a session can ask, be answered, and ask
 * again. Answering retires every open card at once (the answer channel has no
 * correlation id), so in practice at most one is unanswered; taking the last
 * keeps that an observation rather than an assumption.
 *
 * Pure, and derived from the same fold the timeline renders, which is what makes
 * the form and the card two views of one fact instead of two states that can
 * disagree.
 */
export function pendingQuestion(chat: readonly ChatNode[]): ChatNode | null {
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    const node = chat[i];
    if (node.kind === 'question' && !node.questionAnswered) return node;
  }
  return null;
}

/**
 * The picking/sending half of the transcript card, kept here because the mode and
 * the lock it computes are the same facts the composer form reads.
 *
 * `sending` is local and covers only the POST window: the durable answer is the
 * user message the send produces, and the fold's `questionAnswered` takes over
 * the moment its event arrives. On success the flag is deliberately NOT cleared
 * — the surface is about to be retired, and clearing first would flash the
 * buttons live again.
 */
export function useQuestionAnswer(
  node: ChatNode,
  onAnswer?: (text: string) => Promise<boolean>,
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
): {
  mode: 'open' | 'single' | 'multi';
  options: QuestionOption[];
  picked: readonly string[];
  isPicked: (id: string) => boolean;
  toggle: (id: string) => void;
  locked: boolean;
  hint: string | null;
  answered: boolean;
  /** Send one option's label (single choice: the click IS the answer). */
  answerWith: (text: string) => void;
  /** Send the picked labels as one message (multi-select confirm). */
  confirm: () => void;
} {
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [sending, setSending] = useState(false);

  const options = node.questionOptions ?? [];
  const mode = questionMode(node);
  const answered = Boolean(node.questionAnswered);
  const locked = isQuestionLocked({ answered, sending, canSend: Boolean(onAnswer) });

  const send = (text: string) => {
    if (locked || !onAnswer || !text) return;
    setSending(true);
    void onAnswer(text).then((ok) => {
      if (!ok) setSending(false);
    });
  };

  return {
    mode,
    options,
    picked,
    isPicked: (id) => mode === 'multi' && picked.includes(id),
    toggle: (id) => {
      if (locked) return;
      setPicked((current) => togglePicked(current, id));
    },
    locked,
    hint: questionHint(node, t),
    answered,
    answerWith: send,
    confirm: () => send(answerTextFor(options, picked, t)),
  };
}
