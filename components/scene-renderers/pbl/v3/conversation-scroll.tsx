'use client';

import { useLayoutEffect, useRef, useState, type ReactNode, type MouseEvent } from 'react';
import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { wbStyles } from '@/components/workbench/chat/chat-styles';
import { useI18n } from '@/lib/hooks/use-i18n';

/** Follow the tail until the learner scrolls; only Latest opts back in. */
export function ConversationViewport({
  children,
  generating,
  hidden = false,
  onClick,
}: {
  children?: ReactNode;
  generating: boolean;
  hidden?: boolean;
  onClick: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const writtenTop = useRef<number | null>(null);
  const [below, setBelow] = useState(false);
  const measure = () => {
    const scroll = viewport.current;
    if (scroll) setBelow(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 8);
  };
  const follow = () => {
    const scroll = viewport.current;
    if (!scroll) return;
    following.current = true;
    scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight;
    writtenTop.current = scroll.scrollTop;
    measure();
  };
  useLayoutEffect(() => {
    const scroll = viewport.current;
    const body = content.current;
    if (!scroll || !body) return;
    const resize = () => {
      if (following.current) {
        scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight;
        writtenTop.current = scroll.scrollTop;
      }
      setBelow(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 8);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(body);
    observer.observe(scroll);
    resize();
    return () => observer.disconnect();
  }, []);
  const label = generating
    ? `${t('pblV3.journey.latest')} · ${t('workbench.chat.waiting')}`
    : t('pblV3.journey.latest');
  return (
    <div
      role="log"
      aria-label={t('pblV3.learning')}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <div
        ref={viewport}
        tabIndex={0}
        className="pbl-conversation-scroll min-h-0 flex-1 overflow-y-auto"
        style={{ overflowAnchor: 'none' }}
        onWheelCapture={(event) => {
          if (event.deltaY && !event.ctrlKey) following.current = false;
        }}
        onTouchMoveCapture={() => {
          following.current = false;
        }}
        onPointerDown={(event) => {
          // Scrollbar drags do not send wheel events. Ordinary bubble clicks keep following.
          if (
            event.target === event.currentTarget &&
            event.currentTarget.scrollHeight > event.currentTarget.clientHeight
          )
            following.current = false;
        }}
        onKeyDownCapture={(event) => {
          if (
            event.target === event.currentTarget &&
            ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
          )
            following.current = false;
        }}
        onScroll={(event) => {
          const scroll = event.currentTarget;
          // Catch forwarded guide scrolling and other native scrolling, without treating
          // our own writes or the browser clamping a shrinking document as user intent.
          if (
            scroll.scrollTop !== writtenTop.current &&
            scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 1
          )
            following.current = false;
          writtenTop.current = scroll.scrollTop;
          measure();
        }}
      >
        <div ref={content} className="flex flex-col gap-5 p-4" onClick={onClick}>
          {children}
        </div>
      </div>
      {below && !hidden && (
        <div
          data-testid="pbl-conversation-scroll-lane"
          className="absolute bottom-2 left-1/2 -translate-x-1/2"
        >
          <Button
            className="rounded-full"
            size="icon"
            type="button"
            variant="outline"
            aria-label={label}
            title={label}
            data-testid="pbl-conversation-scroll-button"
            data-generating={generating}
            onClick={follow}
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
        </div>
      )}
    </div>
  );
}
