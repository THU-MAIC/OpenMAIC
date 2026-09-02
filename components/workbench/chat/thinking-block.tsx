'use client';

/**
 * Thinking bar — OpenPBL shape. Not a loading spinner: only mounts when
 * there is reasoning text. Collapsed by default, one-line peek of the newest
 * line (that peek is what "scrolls" while streaming), expand in place for
 * the full text. Status changes must not open or close it.
 */
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';

import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';
import { wbStyles as styles } from './chat-styles';
import { formatDurationBetween } from './format';
import { thinkingBarPreview, thinkingBarSummary, useThinkingBar } from './thinking-bar-state';
import type { ToolStackPosition } from './tool-card';

export function ThinkingBlock({
  text,
  streaming = false,
  startedAt,
  endedAt,
  stackPosition = 'single',
  t = defaultWorkbenchTranslator,
}: {
  text: string;
  streaming?: boolean;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
  stackPosition?: ToolStackPosition;
  t?: WorkbenchTranslator;
}) {
  const { expanded, toggle } = useThinkingBar();

  if (!text) return null;

  const summary = thinkingBarSummary(
    {
      streaming,
      duration: formatDurationBetween(startedAt, endedAt),
    },
    t,
  );
  const preview = thinkingBarPreview(text);

  return (
    <div
      className={styles.thinking.box}
      data-open={expanded}
      data-stack={stackPosition}
      data-streaming={streaming || undefined}
      data-testid="workbench-thinking-bar"
    >
      <button
        type="button"
        className={styles.thinking.head}
        aria-expanded={expanded}
        onClick={toggle}
      >
        <span className={styles.thinking.icon} aria-hidden="true">
          <Brain size={13} />
        </span>
        <span className={styles.thinking.text}>
          <span className={styles.thinking.name}>{summary}</span>
          {!expanded && preview ? (
            <span className={styles.thinking.arg} title={preview}>
              {preview}
            </span>
          ) : null}
        </span>
        <span className={styles.thinking.car} aria-hidden="true">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {expanded ? (
        <div className={styles.thinking.body}>
          <pre className={styles.thinking.detail}>{text}</pre>
        </div>
      ) : null}
    </div>
  );
}
