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
import { useEffect } from 'react';
import { create } from 'zustand';
import { sessionScopedKey } from '@/lib/workbench/request-scope';
import { useWorkbenchStore } from '@/lib/workbench/session-store';

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
 * The answer in progress for one question: the picked option ids, whether the
 * free-text row is on, and what was written. ONE per question
 * (`sessionScopedKey(sessionId, node.key)`), shared by every surface that can
 * answer it — the transcript card, the chat's form and the preview's form — so
 * moving between them, or between canned picks and free text, loses nothing.
 * In memory only: a draft is for this visit. Cleared once the question is
 * answered.
 */
export interface QuestionDraft {
  readonly picked: readonly string[];
  readonly otherPicked: boolean;
  readonly otherText: string;
  readonly openText: string;
}

export const EMPTY_QUESTION_DRAFT: QuestionDraft = {
  picked: [],
  otherPicked: false,
  otherText: '',
  openText: '',
};

const MAX_DRAFTS = 50;

interface QuestionDraftState {
  readonly drafts: Readonly<Record<string, QuestionDraft>>;
  readonly update: (key: string, patch: Partial<QuestionDraft>) => void;
  readonly clear: (key: string) => void;
}

export const useQuestionDrafts = create<QuestionDraftState>((set) => ({
  drafts: {},
  update: (key, patch) =>
    set((state) => {
      const rest = Object.entries(state.drafts).filter(([other]) => other !== key);
      const next = { ...(state.drafts[key] ?? EMPTY_QUESTION_DRAFT), ...patch };
      return { drafts: Object.fromEntries([...rest, [key, next]].slice(-MAX_DRAFTS)) };
    }),
  clear: (key) =>
    set((state) => {
      if (!(key in state.drafts)) return state;
      const { [key]: _cleared, ...rest } = state.drafts;
      return { drafts: rest };
    }),
}));

/**
 * This question's shared draft, and the way to change it. Every answering
 * surface goes through here; the draft is dropped once the question is
 * answered, so a later question with a reused key starts empty.
 */
export function useQuestionDraft(
  nodeKey: string,
  answered: boolean,
): {
  readonly draft: QuestionDraft;
  readonly update: (patch: Partial<QuestionDraft>) => void;
  readonly clear: () => void;
} {
  const sessionId = useWorkbenchStore((s) => s.sessionId);
  const key = sessionScopedKey(sessionId, nodeKey);
  const draft = useQuestionDrafts((s) => s.drafts[key]) ?? EMPTY_QUESTION_DRAFT;
  const updateDraft = useQuestionDrafts((s) => s.update);
  const clearDraft = useQuestionDrafts((s) => s.clear);
  useEffect(() => {
    if (answered) clearDraft(key);
  }, [answered, clearDraft, key]);
  return {
    draft,
    update: (patch) => updateDraft(key, patch),
    clear: () => clearDraft(key),
  };
}
