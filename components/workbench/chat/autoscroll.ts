'use client';

/**
 * Sticky-follow re-anchoring for the workbench timeline.
 *
 * The follow/release/re-follow state machine itself is NOT ours: it is
 * `use-stick-to-bottom` (StackBlitz, MIT). It drives the follow off a
 * ResizeObserver on the content rather than a timer, tells its own animated
 * scrolls apart from the user's, and re-locks once the user scrolls back near
 * the bottom. Re-implementing that would be a worse version of a solved
 * problem.
 *
 * What the library cannot know is our domain rule (from OpenPBL's
 * `chat-autoscroll.ts`): escaping the lock is sticky, but *sending a message*
 * is an explicit request to watch the answer, so it must re-anchor even if the
 * user had scrolled away. An agent turn must NOT re-anchor — yanking the
 * viewport while someone is reading earlier material is exactly the behaviour
 * the lock exists to prevent.
 *
 * In the workbench a user message only enters the fold from the event log
 * (`session_start` today, `user_message` once the control plane grows a
 * messages route), so the trigger is "a user node we had not seen at mount",
 * with the mount snapshot as the baseline — which is what keeps a replayed
 * backlog from looking like N sends.
 */
import { useEffect, useRef } from 'react';
import { useStickToBottom, type StickToBottomInstance } from 'use-stick-to-bottom';
import type { ChatNode } from '@/lib/workbench/session-store';

/**
 * Composer rows and question controls grow outside the transcript content, so
 * the library's content observer cannot see them. Track the scroll viewport's
 * own height and let the library retain its existing follow/release state.
 */
export function useWorkbenchViewportAnchor(
  scrollRef: StickToBottomInstance['scrollRef'],
  scrollToBottom: StickToBottomInstance['scrollToBottom'],
): void {
  const scrollToBottomRef = useRef(scrollToBottom);
  useEffect(() => {
    scrollToBottomRef.current = scrollToBottom;
  }, [scrollToBottom]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return;

    let previousHeight = viewport.clientHeight;
    const observer = new ResizeObserver(() => {
      const height = viewport.clientHeight;
      if (height < previousHeight) {
        // A smaller viewport must not re-lock someone reading earlier output.
        void scrollToBottomRef.current({ animation: 'instant', preserveScrollPosition: true });
      }
      previousHeight = height;
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [scrollRef]);
}

function userNodeKeys(chat: ChatNode[]): string[] {
  return chat.filter((n) => n.kind === 'user').map((n) => n.key);
}

export function useWorkbenchAutoscroll(chat: ChatNode[]): {
  scrollRef: StickToBottomInstance['scrollRef'];
  contentRef: StickToBottomInstance['contentRef'];
  isNearBottom: boolean;
  scrollToBottom: StickToBottomInstance['scrollToBottom'];
} {
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const { scrollRef, contentRef, scrollToBottom, isNearBottom } = useStickToBottom({
    // A replayed backlog must open already at the bottom; a spring from the
    // top of a 16-minute log is not an animation, it is a loading screen.
    initial: 'instant',
    resize: reducedMotion ? 'instant' : undefined,
  });
  useWorkbenchViewportAnchor(scrollRef, scrollToBottom);

  // Re-anchor only when a NEW user node appears after the mount baseline —
  // i.e. a local send, never an agent turn and never the replayed backlog.
  const seen = useRef<ReadonlySet<string> | null>(null);
  const userKey = userNodeKeys(chat).join('');
  const scrollToBottomRef = useRef(scrollToBottom);
  scrollToBottomRef.current = scrollToBottom;
  useEffect(() => {
    const current = new Set(userNodeKeys(chat));
    const previous = seen.current;
    seen.current = current;
    if (previous === null) return;
    for (const key of current) {
      if (!previous.has(key)) {
        void scrollToBottomRef.current();
        return;
      }
    }
    // `userKey` serializes the identity set so the effect depends on the
    // nodes, not on the chat array reference rebuilt on every fold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userKey]);

  return { scrollRef, contentRef, isNearBottom, scrollToBottom };
}
