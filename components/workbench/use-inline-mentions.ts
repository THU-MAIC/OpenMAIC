'use client';

/**
 * The composer's `@` mentions, kept beside its draft: picking writes an
 * `@label` into the text at the caret (the input draws it as a chip), and an
 * edit that removes it (Backspace, a cut, a selection typed over) drops the
 * reference it stood for; an undo that brings it back restores both. See
 * `lib/workbench/composer-mentions`.
 *
 * The references themselves stay where each composer keeps them (course
 * refs, staged materials); `onDropped` is how a mention removed from the text
 * takes its reference with it. A reset (a send, a new draft) forgets the
 * mentions without touching the references, which their own paths settle.
 */
import { useCallback, useMemo, useRef, useState } from 'react';

import {
  insertMention,
  mentionLabel,
  mentionsInDraft,
  type InlineMention,
} from '@/lib/workbench/composer-mentions';

const NONE: readonly InlineMention[] = [];

export interface InlineMentions {
  readonly mentions: readonly InlineMention[];
  readonly labels: readonly string[];
  /** Whether this reference is written in the text (and so needs no pill). */
  readonly has: (kind: InlineMention['kind'], id: string) => boolean;
  /**
   * Write a mention for this pick into `draft` at `[start, end)`. Null when it
   * is already in the text: one reference, one mention.
   */
  readonly add: (
    draft: string,
    start: number,
    end: number,
    pick: { readonly kind: InlineMention['kind']; readonly id: string; readonly name: string },
  ) => { readonly draft: string; readonly caret: number } | null;
  /** After the draft was edited: forget, and drop, the mentions it no longer holds. */
  readonly afterEdit: (draft: string) => void;
  /** An undo or redo brought this mention's chip back: it and its reference return. */
  readonly revive: (mention: InlineMention) => void;
  readonly reset: () => void;
  readonly restore: (mentions: readonly InlineMention[]) => void;
}

export function useInlineMentions(
  onDropped: (mention: InlineMention) => void,
  onRevived: (mention: InlineMention) => void,
): InlineMentions {
  const [mentions, setMentions] = useState<readonly InlineMention[]>(NONE);
  // The latest list for handlers called twice in one event (pick, then edit).
  const current = useRef(mentions);
  const commit = useCallback((next: readonly InlineMention[]) => {
    current.current = next;
    setMentions(next);
  }, []);
  const labels = useMemo(() => mentions.map((mention) => mention.label), [mentions]);

  const has = useCallback(
    (kind: InlineMention['kind'], id: string) =>
      mentions.some((mention) => mention.kind === kind && mention.id === id),
    [mentions],
  );

  const add: InlineMentions['add'] = useCallback(
    (draft, start, end, pick) => {
      const list = current.current;
      if (list.some((mention) => mention.kind === pick.kind && mention.id === pick.id)) {
        return null;
      }
      const label = mentionLabel(
        pick.name,
        list.map((mention) => mention.label),
      );
      commit([...list, { label, kind: pick.kind, id: pick.id, name: pick.name }]);
      return insertMention(draft, label, start, end);
    },
    [commit],
  );

  const afterEdit = useCallback(
    (draft: string) => {
      const list = current.current;
      const kept = mentionsInDraft(draft, list);
      if (kept === list) return;
      for (const mention of list) if (!kept.includes(mention)) onDropped(mention);
      commit(kept);
    },
    [commit, onDropped],
  );

  const revive: InlineMentions['revive'] = useCallback(
    (mention) => {
      if (current.current.some((item) => item.label === mention.label)) return;
      commit([...current.current, mention]);
      onRevived(mention);
    },
    [commit, onRevived],
  );

  const reset = useCallback(() => commit(NONE), [commit]);
  const restore = useCallback((list: readonly InlineMention[]) => commit(list), [commit]);

  return { mentions, labels, has, add, afterEdit, revive, reset, restore };
}
