'use client';
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningConversationEntry } from '@/lib/pbl/v3/conversation';

type Submission = { id: string; studyId: string; text: string };
const confirmed = (submission: Submission, view: LearningView | null) =>
  view?.id === submission.studyId &&
  view.conversation?.some((entry) => entry.speaker === 'user' && entry.commandId === submission.id);

/** Local send acknowledgement only; durable server observations own the conversation. */
export function useLearnerMessage(
  view: LearningView | null,
  setText: Dispatch<SetStateAction<string>>,
) {
  const [pending, setPending] = useState<Submission | null>(null);
  const current = useRef<Submission | null>(null);
  const begin = useCallback(
    (view: LearningView, id: string, text: string) => {
      const submission = {
        id,
        studyId: view.id,
        text,
      };
      current.current = submission;
      setPending(submission);
      setText((draft) => (draft === text ? '' : draft));
    },
    [setText],
  );
  const finish = useCallback(
    (id: string, succeeded: boolean, observed: LearningView | null) => {
      const submission = current.current;
      if (!submission || submission.id !== id) return;
      // A lost HTTP acknowledgement can still have a durable SSE receipt.
      // Restore rejected/unconfirmed text without replacing a newer draft.
      if (!succeeded && !confirmed(submission, observed))
        setText((draft) => draft || submission.text);
      current.current = null;
      setPending(null);
    },
    [setText],
  );
  const entry: LearningConversationEntry | null =
    pending && view?.id === pending.studyId && !confirmed(pending, view)
      ? {
          id: `sending-${pending.id}`,
          speaker: 'user',
          parts: [{ kind: 'text', id: pending.id, text: pending.text }],
        }
      : null;
  return { entry, begin, finish };
}
