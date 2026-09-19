import { useElementRefsStore } from '@/lib/store/element-refs';
import type { ElementRef } from '@/lib/workbench/element-refs';

/**
 * Finalize a successful message POST without losing a retryable ref draft.
 * A missing capability receipt means an old route accepted the text but
 * silently ignored elementRefs during a rolling deploy.
 */
export function settleSentElementRefs({
  sessionId,
  sent,
  elementRefsAccepted,
  warnUnsupported,
}: {
  sessionId: string;
  sent: readonly ElementRef[];
  elementRefsAccepted: boolean;
  warnUnsupported: () => void;
}): void {
  if (sent.length === 0) return;
  if (!elementRefsAccepted) {
    warnUnsupported();
    return;
  }
  useElementRefsStore.getState().removeSent(sessionId, sent);
}
