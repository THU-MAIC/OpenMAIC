'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { useStickToBottomContext, type GetTargetScrollTop } from 'use-stick-to-bottom';
import { Button } from '@/components/ui/button';
import { wbStyles } from '@/components/workbench/chat/chat-styles';
import { useI18n } from '@/lib/hooks/use-i18n';

/** Follow a growing reply only until its heading reaches the reading area's top. */
export function useConversationScrollTarget(turnId: string | null, sent: number) {
  const followTail = useRef(false);
  const currentTurn = useRef(turnId);
  useLayoutEffect(() => {
    currentTurn.current = turnId;
    followTail.current = false;
  }, [turnId, sent]);
  // The scroll library retains its initial target callback. Keep that callback
  // stable and read the current reply through a ref instead of a stale closure.
  const targetScrollTop = useCallback<GetTargetScrollTop>(
    (target, { scrollElement, contentElement }) => {
      const id = currentTurn.current;
      if (followTail.current || !id) return target;
      const turn = [...contentElement.querySelectorAll<HTMLElement>('[data-turn-id]')].find(
        (element) => element.dataset.turnId === id,
      );
      if (!turn) return target;
      const heading =
        scrollElement.scrollTop +
        turn.getBoundingClientRect().top -
        scrollElement.getBoundingClientRect().top -
        12;
      // Manual reading below the heading must never be pulled back upward.
      return Math.min(target, Math.max(scrollElement.scrollTop, heading));
    },
    [],
  );
  const follow = useCallback(() => {
    followTail.current = true;
  }, []);
  return { targetScrollTop, follow };
}

export function ConversationScroll({
  sent,
  generating,
  onFollow,
}: {
  sent: number;
  generating: boolean;
  onFollow: () => void;
}) {
  const { contentRef, scrollRef, scrollToBottom } = useStickToBottomContext();
  const { t } = useI18n();
  const previous = useRef(sent);
  const [below, setBelow] = useState(false);
  useLayoutEffect(() => {
    if (previous.current !== sent) {
      previous.current = sent;
      // A spring can overshoot the reply heading and hide its opening text.
      // Re-anchor precisely; manual scrolling and the explicit tail button stay independent.
      void scrollToBottom({ animation: 'instant' });
    }
  }, [sent, scrollToBottom]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current,
      content = contentRef.current;
    if (!scroll || !content) return;
    const measure = () =>
      setBelow(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 8);
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    observer.observe(scroll);
    scroll.addEventListener('scroll', measure, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      scroll.removeEventListener('scroll', measure);
    };
  }, [contentRef, scrollRef]);

  if (!below) return null;
  const label = generating
    ? `${t('pblV3.journey.latest')} · ${t('workbench.chat.waiting')}`
    : t('pblV3.journey.latest');
  return (
    <Button
      className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full"
      size="icon"
      type="button"
      variant="outline"
      aria-label={label}
      title={label}
      data-testid="pbl-conversation-scroll-button"
      data-generating={generating}
      onClick={() => {
        onFollow();
        void scrollToBottom();
      }}
    >
      {generating ? (
        <span className={wbStyles.waiting.dots} aria-hidden="true">
          <i className={wbStyles.waiting.dot} />
          <i className={wbStyles.waiting.dotDelayOne} />
          <i className={wbStyles.waiting.dotDelayTwo} />
        </span>
      ) : (
        <ArrowDown className="size-4" />
      )}
    </Button>
  );
}
