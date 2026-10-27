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
  /** The key of the question the preview is showing as its form, if any. */
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
