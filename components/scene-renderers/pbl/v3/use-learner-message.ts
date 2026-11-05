'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningConversationEntry } from '@/lib/pbl/v3/conversation';
import {
  readPendingMessage,
  beginPendingMessage,
  acknowledgePendingMessage,
  recoverPendingMessage,
} from './use-project-drafts';

type Submission = { id: string; studyId: string; text: string };
const confirmed = (submission: Submission, view: LearningView | null) =>
  view?.id === submission.studyId &&
  view.conversation?.some((entry) => entry.speaker === 'user' && entry.commandId === submission.id);

/** Local send acknowledgement only; durable server observations own the conversation. */
export function useLearnerMessage(
  view: LearningView | null,
  onStorageError: () => void,
  savedMessage: { id: string } | undefined,
) {
  const [pending, setPending] = useState<Submission | null>(null);
  const current = useRef<Submission | null>(null);
  const observe = useCallback(
    (observed: LearningView | null) => {
      if (!observed) return;
      const saved = readPendingMessage(observed.id);
      if (!saved || !confirmed({ ...saved, studyId: observed.id }, observed)) return;
      // Persist the acknowledgement when it arrives, before navigation can replace
      // the active view. A late failure can only recover a still-unconfirmed record.
      if (!acknowledgePendingMessage(observed.id, saved.id)) onStorageError();
    },
    [onStorageError],
  );
  useEffect(() => {
    observe(view);
    if (!view) return;
    const saved = readPendingMessage(view.id);
    if (saved && (current.current?.id !== saved.id || current.current.studyId !== view.id)) {
      if (!recoverPendingMessage(view.id, saved.id)) onStorageError();
    }
  }, [view, observe, onStorageError]);
  const begin = useCallback(
    (view: LearningView, id: string, text: string) => {
      const submission = {
        id,
        studyId: view.id,
        text,
      };
      current.current = submission;
      setPending(submission);
      if (!beginPendingMessage(view.id, id, text)) onStorageError();
    },
    [onStorageError],
  );
  const finish = useCallback(
    (id: string, succeeded: boolean, observed: LearningView | null) => {
      const submission = current.current;
      if (!submission || submission.id !== id) return;
      observe(observed);
      const saved = succeeded
        ? acknowledgePendingMessage(submission.studyId, id)
        : recoverPendingMessage(submission.studyId, id);
      if (!saved) onStorageError();
      current.current = null;
      setPending(null);
    },
    [observe, onStorageError],
  );
  const entry: LearningConversationEntry | null =
    pending &&
    savedMessage?.id === pending.id &&
    view?.id === pending.studyId &&
    !confirmed(pending, view)
      ? {
          id: `sending-${pending.id}`,
          speaker: 'user',
          parts: [{ kind: 'text', id: pending.id, text: pending.text }],
        }
      : null;
  return { entry, begin, finish, observe };
}
