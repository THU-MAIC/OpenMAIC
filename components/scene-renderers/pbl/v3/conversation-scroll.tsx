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
  sent,
  generating,
  hidden = false,
  onClick,
}: {
  children?: ReactNode;
  sent: number;
  generating: boolean;
  hidden?: boolean;
  onClick: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const { t } = useI18n();
  const { scrollRef, contentRef, isNearBottom, scrollToBottom } = useStickToBottom({
    initial: 'instant',
    resize: 'instant',
  });
  useWorkbenchViewportAnchor(scrollRef, scrollToBottom);
  const previous = useRef(sent);
  useLayoutEffect(() => {
    if (previous.current !== sent) {
      previous.current = sent;
      // A new learner send explicitly asks to follow its answer, as in Pro.
      void scrollToBottom({ animation: 'instant' });
    }
  }, [sent, scrollToBottom]);
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
        ref={scrollRef}
        tabIndex={0}
        className="pbl-conversation-scroll min-h-0 flex-1 overflow-y-auto"
      >
        <div ref={contentRef} className="flex flex-col gap-5 p-4" onClick={onClick}>
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
