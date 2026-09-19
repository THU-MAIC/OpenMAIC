'use client';

/**
 * Tool group — consecutive tool calls share one frame. The outer group stays
 * expanded while tools run and auto-collapses once every call settles (unless
 * the user took manual control); each card's detail stays collapsed
 * (independent expand). Ported from OpenPBL's `tool-group.tsx`.
 *
 * The auto-fold is deliberately unhurried: it waits out both the settle pause
 * and a minimum time on screen, so a group whose calls all return in a few
 * hundred milliseconds still gets read before it folds.
 *
 * The fold is animated, so the card list stays mounted while collapsed (a
 * `0fr` grid row clips it to zero height) — that is what lets both directions
 * transition instead of snapping, and a group that mounts already collapsed
 * still renders its first frame folded, with nothing to animate.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, List, Sparkles } from 'lucide-react';
import type { ChatNode, PlannedPage } from '@/lib/workbench/session-store';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';
import { wbStyles as styles } from './chat-styles';
import { StatusDot } from './status-dot';
import { ToolCard, type ToolStackPosition } from './tool-card';
import { isSkillLoadTool } from './tool-presentation';
import {
  aggregateToolGroupStatus,
  initialToolGroupOpen,
  shouldScheduleAutoCollapse,
  toolGroupCollapseDelayMs,
} from './tool-group-state';

export function stackPosition(index: number, total: number): ToolStackPosition {
  if (total <= 1) return 'single';
  if (index === 0) return 'first';
  if (index === total - 1) return 'last';
  return 'middle';
}

const STATUS_DOT: Record<'running' | 'error' | 'done', string> = {
  running: 'running',
  error: 'error',
  done: 'done',
};

export function ToolGroup({
  nodes,
  plan = [],
  t = defaultWorkbenchTranslator,
}: {
  nodes: ChatNode[];
  plan?: PlannedPage[];
  t?: WorkbenchTranslator;
}) {
  const status = aggregateToolGroupStatus(nodes);
  const [open, setOpen] = useState(() => initialToolGroupOpen(status));
  const [userToggled, setUserToggled] = useState(false);
  // Both clocks the fold depends on. `firstVisibleAt` is the mount — the row
  // key of a tool run is its first call, so the group keeps one identity (and
  // one visibility floor) while later calls stream in.
  const [firstVisibleAt] = useState(() => Date.now());
  const settledAt = useRef<number | null>(null);
  // One boolean drives the whole auto-fold: while it holds, a collapse is owed
  // once both deadlines have passed; the cleanup cancels it the moment it stops
  // holding (a call went back to running, the user folded it by hand) or the
  // group unmounts. Depending on the boolean — not on `status` — keeps a
  // done→error flip inside the window from restarting the clock, since the
  // effect (and with it `settledAt`) only re-runs when the group crosses
  // between running and settled. A lone tool has no fold to close, so it is
  // owed nothing.
  const autoCollapsePending =
    nodes.length > 1 && shouldScheduleAutoCollapse(status, open, userToggled);
  useEffect(() => {
    if (!autoCollapsePending) {
      // Back to running (or folded by hand): the next settled stretch re-times
      // its own pause, while the visibility floor stays where it was.
      settledAt.current = null;
      return;
    }
    settledAt.current ??= Date.now();
    const delay = toolGroupCollapseDelayMs(Date.now(), firstVisibleAt, settledAt.current);
    const timer = window.setTimeout(() => setOpen(false), delay);
    return () => window.clearTimeout(timer);
  }, [autoCollapsePending, firstVisibleAt]);
  if (nodes.length === 0) return null;
  // A lone tool renders as a standalone card (no group chrome), matching the
  // single-tool case.
  if (nodes.length === 1) {
    return <ToolCard node={nodes[0]} plan={plan} stackPosition="single" t={t} />;
  }

  const skillGroup = nodes.every(isSkillLoadTool);
  const GroupIcon = skillGroup ? Sparkles : List;

  return (
    <div
      className={styles.toolGroup.group}
      data-open={open}
      data-kind={skillGroup ? 'skill' : 'tool'}
      data-testid={skillGroup ? 'workbench-skill-group' : 'workbench-tool-group'}
    >
      <button
        type="button"
        className={styles.toolGroup.head}
        aria-expanded={open}
        onClick={() => {
          setUserToggled(true);
          setOpen((v) => !v);
        }}
      >
        <StatusDot status={STATUS_DOT[status]} />
        <span className={styles.toolGroup.icon} aria-hidden="true">
          <GroupIcon size={13} />
        </span>
        <span className={styles.toolGroup.title}>
          {t(skillGroup ? 'workbench.tool.group.skills' : 'workbench.tool.group.tools', {
            count: nodes.length,
          })}
        </span>
        <span className={styles.toolGroup.meta}>· {t(`workbench.tool.group.${status}`)}</span>
        <span className={styles.toolGroup.car} aria-hidden="true">
          <ChevronRight size={13} />
        </span>
      </button>
      {/* The clipped row: `0fr → 1fr` is the height transition; the cards below
          it are inert while folded so a collapsed group keeps no tab stops. */}
      <div className={styles.toolGroup.bodyRow} inert={!open} aria-hidden={!open}>
        <div className={styles.toolGroup.body}>
          {nodes.map((node, index) => (
            <ToolCard
              key={node.key}
              node={node}
              plan={plan}
              t={t}
              stackPosition={stackPosition(index, nodes.length)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
