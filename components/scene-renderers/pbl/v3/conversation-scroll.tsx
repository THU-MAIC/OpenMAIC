'use client';

import { useLayoutEffect, useRef, type ReactNode, type MouseEvent } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkbenchViewportAnchor } from '@/components/workbench/chat/autoscroll';
import { wbStyles } from '@/components/workbench/chat/chat-styles';
import { useI18n } from '@/lib/hooks/use-i18n';

/** Use the same follow/release/re-follow mechanism as the Pro workbench. */
export function ConversationViewport({
  children,
  header,
  sent,
  startAtOverview = false,
  generating,
  hidden = false,
  onClick,
}: {
  children?: ReactNode;
  header?: ReactNode;
  sent: number;
  startAtOverview?: boolean;
  generating: boolean;
  hidden?: boolean;
  onClick: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const { t } = useI18n();
  const stick = useStickToBottom({
    initial: startAtOverview && header ? false : 'instant',
    resize: 'instant',
  });
  const { contentRef, scrollRef, isNearBottom, scrollToBottom, stopScroll } = stick;
  // Capture entry intent once. Acknowledging the tour must not erase it before
  // the overview is revealed, and replaying the tour must not reset reading.
  const revealOverview = useRef(startAtOverview);
  const viewportRef = useWorkbenchViewportAnchor(stick);
  const previous = useRef(sent);
  useLayoutEffect(() => {
    if (previous.current !== sent) {
      previous.current = sent;
      revealOverview.current = false;
      // A new learner send explicitly asks to follow its answer, as in Pro.
      void scrollToBottom({ animation: 'instant' });
    } else if (revealOverview.current && header) {
      revealOverview.current = false;
      // Only the initial reading position changes. The shared follow state
      // resumes normally on a send, Latest, or scrolling back to the bottom.
      stopScroll();
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
  }, [header, sent, scrollRef, scrollToBottom, stopScroll]);
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
        ref={viewportRef}
        tabIndex={0}
        className="pbl-conversation-scroll min-h-0 flex-1 overflow-y-auto"
      >
        <div ref={contentRef} className="flex flex-col gap-5 p-4" onClick={onClick}>
          {header && (
            <div onPointerDownCapture={stick.stopScroll} onKeyDownCapture={stick.stopScroll}>
              {header}
            </div>
          )}
          {children}
        </div>
      </div>
      {!isNearBottom && !hidden && (
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
            onClick={() => void scrollToBottom()}
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
