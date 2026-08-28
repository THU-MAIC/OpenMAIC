'use client';

/**
 * Collapse logic for the thinking bar, kept out of the component so it can be
 * unit-tested without a DOM. Ported from OpenPBL's `thinking-bar-state.ts`.
 *
 * The rule the UI has to honour is small but easy to get wrong by accident:
 * the bar is ALWAYS collapsed on first render, and nothing except a click may
 * open or close it — in particular a run finishing must not yank the panel
 * shut under a reader who just opened it.
 */
import { useCallback, useState } from 'react';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';

export type ThinkingBarState = {
  /** Set once the user has clicked the bar, so the choice outlives status changes. */
  readonly touched: boolean;
  readonly expanded: boolean;
};

export const collapsedThinkingBar: ThinkingBarState = { touched: false, expanded: false };

export function toggleThinkingBar(state: ThinkingBarState): ThinkingBarState {
  return { touched: true, expanded: !state.expanded };
}

/**
 * The streaming -> done transition is deliberately a no-op. It exists as a
 * named function so the "status changes must not move the disclosure" rule is
 * something a test can pin, rather than an absence of code that a later edit
 * could silently fill in.
 */
export function onThinkingStatusChange(state: ThinkingBarState): ThinkingBarState {
  return state;
}

/** Header text: activity while the model is still emitting, elapsed time once not. */
export function thinkingBarSummary(
  {
    streaming,
    duration,
  }: {
    streaming: boolean;
    duration?: string;
  },
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
): string {
  if (streaming) return t('workbench.thinking.active');
  return duration
    ? t('workbench.thinking.doneWithDuration', { duration })
    : t('workbench.thinking.done');
}

const PREVIEW_MAX = 200;

/**
 * The one-line peek shown on the collapsed bar. While streaming this is the
 * newest line, so the bar visibly moves; once done it is the model's last
 * line, which is where its conclusion lands. Capped so a single unbroken
 * paragraph cannot put a 50k-character text node in the DOM for a row that is
 * one line tall.
 */
export function thinkingBarPreview(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX)}…` : line;
  }
  return '';
}

export function useThinkingBar(): { expanded: boolean; toggle: () => void } {
  const [state, setState] = useState<ThinkingBarState>(collapsedThinkingBar);
  const toggle = useCallback(() => setState(toggleThinkingBar), []);
  return { expanded: state.expanded, toggle };
}
