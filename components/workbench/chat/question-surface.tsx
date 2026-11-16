'use client';

/**
 * The whole visible surface of one question, as the auto-confirm countdown
 * sees it.
 *
 * The countdown pauses while the pointer rests on the question and stops at
 * the first press inside it (`question-auto-confirm-state.ts`). "The question"
 * has to mean everything the user can be reading or acting on — its title, its
 * details, its options and its footer — not just the answer form: a host that
 * draws the title and details itself (the request preview) wraps them and the
 * form in this one boundary, and the form's countdown listens on it. Without a
 * surface around it, the form's own frame is the boundary (the composer
 * takeover, which draws the question and details inside the form).
 */
import { createContext, useContext, useRef, type ReactNode, type RefObject } from 'react';

const QuestionSurfaceContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

/** The enclosing question surface's element, if the form sits inside one. */
export function useQuestionSurface(): RefObject<HTMLDivElement | null> | null {
  return useContext(QuestionSurfaceContext);
}

export function QuestionSurface({
  className,
  testId,
  children,
}: {
  readonly className?: string;
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <QuestionSurfaceContext.Provider value={ref}>
      <div ref={ref} className={className} data-testid={testId} data-question-surface="">
        {children}
      </div>
    </QuestionSurfaceContext.Provider>
  );
}
