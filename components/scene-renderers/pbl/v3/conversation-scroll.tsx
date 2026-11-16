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
  // Layout changes (including hiding the overview during onboarding) are not
  // learner intent. Keep the initial target until the learner chooses to move.
  const readingOverview = useRef(startAtOverview);
  const stick = useStickToBottom({
    initial: startAtOverview ? false : 'instant',
    resize: 'instant',
  });
  const { contentRef, scrollRef, isNearBottom, scrollToBottom, stopScroll } = stick;
  const viewportRef = useWorkbenchViewportAnchor(stick);
  const previous = useRef(sent);
  useLayoutEffect(() => {
    // The library re-locks when shrinking content brings it near the bottom.
    // Suppress that layout-only re-lock during the initial overview, before
    // its scheduled animation runs. Keep its normal bottom-distance reporting.
    const observer = new ResizeObserver(() => {
      if (readingOverview.current) stopScroll();
    });
    if (contentRef.current) observer.observe(contentRef.current);
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, [contentRef, scrollRef, stopScroll]);
  const releaseOverview = () => {
    if (!readingOverview.current) return;
    readingOverview.current = false;
    // Let the gesture choose the position; do not jump to the tail on a wheel
    // or touch gesture that only starts reading the opening reply.
    stopScroll();
  };
  useLayoutEffect(() => {
    if (previous.current !== sent) {
      previous.current = sent;
      readingOverview.current = false;
      // A new learner send explicitly asks to follow its answer, as in Pro.
      void scrollToBottom({ animation: 'instant' });
    } else if (readingOverview.current && header) {
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
        onWheelCapture={releaseOverview}
        onTouchMoveCapture={releaseOverview}
        onPointerDownCapture={(event) => {
          if (event.target === event.currentTarget) releaseOverview();
        }}
        onKeyDownCapture={(event) => {
          if (
            event.target === event.currentTarget &&
            ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
          )
            releaseOverview();
        }}
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
            onClick={() => {
              readingOverview.current = false;
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
        </div>
      )}
    </div>
  );
}
