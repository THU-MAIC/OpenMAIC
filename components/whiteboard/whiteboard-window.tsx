'use client';

import type { ComponentProps } from 'react';
import { FloatingWindow, type WindowRect } from '@/components/ui/floating-window';
import { cn } from '@/lib/utils';
import { WhiteboardFrame, WHITEBOARD_SHELL_CLASS } from './whiteboard-frame';

/**
 * The whiteboard as every surface shows it: one sheet the learner drags by its title bar
 * and resizes from its edges, inside whatever area the host gives it.
 */
export function WhiteboardWindow({
  initial,
  className,
  testId,
  ...frame
}: Omit<ComponentProps<typeof WhiteboardFrame>, 'draggable'> & {
  /** Where the sheet first appears within the host area. */
  readonly initial: (bounds: { width: number; height: number }) => WindowRect;
  readonly className?: string;
  readonly testId?: string;
}) {
  return (
    <FloatingWindow
      testId={testId}
      minWidth={420}
      minHeight={300}
      initial={initial}
      className={cn(WHITEBOARD_SHELL_CLASS, className)}
    >
      <WhiteboardFrame {...frame} draggable />
    </FloatingWindow>
  );
}
