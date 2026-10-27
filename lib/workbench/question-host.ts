'use client';

/**
 * Where the agent's open question is answered.
 *
 * The conversation owns the ONE answer path (`WorkbenchChat`'s send: the
 * answer is an ordinary user message, the whole `ask_user` protocol). It
 * publishes that path here, and the request preview, which shows the question
 * as its primary surface while a request has no classroom yet, answers through
 * it. The preview also says which question it is hosting, so the conversation
 * shows a compact pointer instead of a second form. Answering in either place
 * sends the same message, and the fold retires the question for both.
 */
import { create } from 'zustand';

export type QuestionAnswerer = (text: string) => Promise<boolean>;

interface QuestionHostState {
  /** The conversation's answer path, while a conversation is mounted. */
  readonly answer: QuestionAnswerer | null;
  /**
   * The question the preview is showing as its form, if any, as
   * `sessionScopedKey(sessionId, node.key)` (`lib/workbench/request-scope.ts`).
   */
  readonly previewKey: string | null;
  readonly setAnswer: (answer: QuestionAnswerer | null) => void;
  readonly setPreviewKey: (key: string | null) => void;
}

export const useQuestionHost = create<QuestionHostState>((set) => ({
  answer: null,
  previewKey: null,
  setAnswer: (answer) => set({ answer }),
  setPreviewKey: (previewKey) => set({ previewKey }),
}));

/**
 * A half-written answer, kept per question (`sessionScopedKey(sessionId,
 * node.key)`) so it survives the question moving between the chat's form and
 * the preview's. In memory only: a draft is for this visit.
 */
export interface QuestionDraft {
  readonly picked: readonly string[];
  readonly otherPicked: boolean;
  readonly otherText: string;
  readonly openText: string;
  readonly highlight: number;
}

const MAX_DRAFTS = 20;
const drafts = new Map<string, QuestionDraft>();

export function readQuestionDraft(key: string): QuestionDraft | null {
  return drafts.get(key) ?? null;
}

export function writeQuestionDraft(key: string, draft: QuestionDraft): void {
  drafts.delete(key);
  drafts.set(key, draft);
  while (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value as string);
}
