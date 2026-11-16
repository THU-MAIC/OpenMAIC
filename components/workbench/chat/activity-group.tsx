'use client';

/**
 * The agent's work between two things it said: thinking and tool calls, however they
 * alternate, as one row. Prose ends a stretch, and so does anything else with a meaning
 * of its own (a question, a notice, a course card), which is why those never reach here
 * (see `rowsForRender`). Expanded, it is every bar in its original order, each with its
 * own disclosure.
 *
 * It opens and closes only by hand: a run finishing moves nothing under the reader, and
 * one line that keeps its height as steps come and go moves nothing below it. While it
 * runs the line says the step under way and nothing else; settled, it says what it came
 * to; a failure stays on the line either way.
 *
 * The body stays mounted while folded (a `0fr` grid row clips it to zero height), so
 * both directions animate and a disclosure opened inside keeps its state.
 */
import { useState } from 'react';
import { ChevronRight, List } from 'lucide-react';
import type { ChatNode, PlannedPage } from '@/lib/workbench/session-store';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';
import { summarizeActivity } from './activity-summary';
import { wbStyles as styles } from './chat-styles';
import { formatDurationMs } from './format';
import { StatusDot } from './status-dot';
import { ThinkingBlock } from './thinking-block';
import { ToolCard, type ToolStackPosition } from './tool-card';

export function stackPosition(index: number, total: number): ToolStackPosition {
  if (total <= 1) return 'single';
  if (index === 0) return 'first';
  if (index === total - 1) return 'last';
  return 'middle';
}

export function ActivityGroup({
  nodes,
  plan = [],
  ongoing = false,
  t = defaultWorkbenchTranslator,
}: {
  nodes: ChatNode[];
  plan?: PlannedPage[];
  /** The turn is still going and this is where it has got to. */
  ongoing?: boolean;
  t?: WorkbenchTranslator;
}) {
  const [open, setOpen] = useState(false);
  const summary = summarizeActivity(nodes, plan, t, ongoing);
  const bars = nodes.filter((node) => node.kind !== 'waiting');
  const counts = [
    summary.thought ? t('workbench.thinking.done') : null,
    summary.toolCount > 0 ? t('workbench.tool.group.tools', { count: summary.toolCount }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const failed =
    summary.failedCount > 0 ? t('workbench.tool.group.failed', { count: summary.failedCount }) : '';
  const duration = formatDurationMs(summary.durationMs);

  return (
    <div
      className={styles.toolGroup.group}
      data-open={open}
      data-status={summary.status}
      data-testid="workbench-activity-group"
    >
      <button
        type="button"
        className={styles.toolGroup.head}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <StatusDot status={summary.status} />
        <span className={styles.toolGroup.icon} aria-hidden="true">
          <List size={13} />
        </span>
        {summary.status === 'running' ? (
          <span
            className={styles.toolGroup.live}
            title={summary.live}
            data-testid="workbench-activity-live"
          >
            {summary.live}
          </span>
        ) : (
          <>
            <span className={styles.toolGroup.title}>{counts}</span>
            {failed ? null : (
              <span className={styles.toolGroup.meta}>· {t('workbench.tool.group.done')}</span>
            )}
          </>
        )}
        {failed ? (
          <span className={styles.toolGroup.failed} data-testid="workbench-activity-failed">
            · {failed}
          </span>
        ) : null}
        <span className={styles.toolGroup.reason} title={summary.failureReason}>
          {summary.failureReason}
        </span>
        {duration ? <time className={styles.toolGroup.time}>{duration}</time> : null}
        <span className={styles.toolGroup.car} aria-hidden="true">
          <ChevronRight size={13} />
        </span>
      </button>
      {/* The clipped row: `0fr → 1fr` is the height transition; the bars below it are
          inert while folded so a collapsed group keeps no tab stops. */}
      <div className={styles.toolGroup.bodyRow} inert={!open} aria-hidden={!open}>
        <div className={styles.toolGroup.body}>
          {bars.map((node, index) =>
            node.kind === 'thinking' ? (
              <ThinkingBlock
                key={node.key}
                text={node.text}
                streaming={node.streaming}
                startedAt={node.startedAt}
                endedAt={node.endedAt}
                stackPosition={stackPosition(index, bars.length)}
                t={t}
              />
            ) : (
              <ToolCard
                key={node.key}
                node={node}
                plan={plan}
                stackPosition={stackPosition(index, bars.length)}
                t={t}
              />
            ),
          )}
        </div>
      </div>
    </div>
  );
}
