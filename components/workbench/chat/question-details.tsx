'use client';

/**
 * The supporting material an `ask_user` question carries (`details`): a
 * proposed plan, the reasoning behind the options. It is whatever Markdown the
 * agent wrote — no structure is assumed — so it renders as ordinary prose,
 * clamped to a few lines until the user expands it. The question stays the one
 * line that needs reading; this is there for whoever wants it.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';
import { cn } from '@/lib/utils/cn';
import { wbStyles as styles } from './chat-styles';
import { TextBlock } from './text-block';

export function QuestionDetails({
  text,
  className,
  testId = 'workbench-question-details',
  t = defaultWorkbenchTranslator,
}: {
  readonly text: string;
  readonly className?: string;
  readonly testId?: string;
  readonly t?: WorkbenchTranslator;
}) {
  const [open, setOpen] = useState(false);
  // Short material needs no toggle and no fade: measured, not guessed from the text.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(true);
  // Re-measured whenever the block is resized too: a pane narrowed after the
  // first paint can make the same text overflow, and it must not stay clipped
  // with no way to open it.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || open) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, text]);
  return (
    <div
      className={cn(styles.questionDetails.box, className)}
      data-testid={testId}
      data-open={open ? 'true' : 'false'}
    >
      <div
        ref={bodyRef}
        className={
          open
            ? styles.questionDetails.bodyOpen
            : overflows
              ? styles.questionDetails.bodyClamped
              : styles.questionDetails.bodyFits
        }
      >
        <TextBlock text={text} />
      </div>
      {open || overflows ? (
        <button
          type="button"
          className={styles.questionDetails.toggle}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {t(open ? 'workbench.question.hideDetails' : 'workbench.question.showDetails')}
          <ChevronDown
            className={cn(styles.questionDetails.chevron, open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      ) : null}
    </div>
  );
}
