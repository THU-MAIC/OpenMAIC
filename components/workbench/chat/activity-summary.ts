/**
 * What a stretch of the agent's work comes to, in one line: pure, so that a live run
 * and a replayed log say the same thing about the same events.
 */
import type { ChatNode, PlannedPage } from '@/lib/workbench/session-store';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';
import { isWorkbenchToolFailed, presentTool } from './tool-presentation';
import { deriveToolProgress, progressLine } from './tool-progress';

export type ActivityStatus = 'running' | 'error' | 'done';

export interface ActivitySummary {
  readonly status: ActivityStatus;
  readonly thought: boolean;
  readonly toolCount: number;
  readonly failedCount: number;
  /** While running: the step under way, so progress is not hidden behind a count. */
  readonly live?: string;
  /** Why the stretch stopped, when it ended on a failure. */
  readonly failureReason?: string;
  /** First start to last end, once settled. */
  readonly durationMs?: number;
}

function toolStep(node: ChatNode, plan: PlannedPage[], t: WorkbenchTranslator): string {
  const presentation = presentTool(node, plan, t);
  const progress =
    node.toolState === 'running'
      ? deriveToolProgress(
          {
            toolName: node.toolName,
            traces: presentation.hidePayload ? [] : (node.toolTraces ?? []),
            running: true,
            failed: false,
          },
          t,
        )
      : null;
  const line = progress ? progressLine(progress) : undefined;
  return [presentation.label, line ?? presentation.subject].filter(Boolean).join(' · ');
}

export function summarizeActivity(
  nodes: readonly ChatNode[],
  plan: PlannedPage[] = [],
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
  /** The turn goes on past these events: nothing may be running this instant, yet it is not over. */
  ongoing = false,
): ActivitySummary {
  const bars = nodes.filter((node) => node.kind !== 'waiting');
  const tools = bars.filter((node) => node.kind === 'tool');
  const failed = tools.filter(isWorkbenchToolFailed);
  const runningTool = tools.findLast((node) => node.toolState === 'running');
  const streaming = bars.some((node) => node.kind === 'thinking' && node.streaming);
  const running = ongoing || Boolean(runningTool) || streaming || nodes.at(-1)?.kind === 'waiting';
  const base = {
    thought: bars.some((node) => node.kind === 'thinking'),
    toolCount: tools.length,
    failedCount: failed.length,
  };

  if (running) {
    const last = bars.at(-1);
    // Between two steps the row keeps saying the one that just ended, so it does not
    // flicker through "thinking" on every gap.
    const current = runningTool ?? (!streaming && last?.kind === 'tool' ? last : undefined);
    return {
      ...base,
      status: 'running',
      live: current ? toolStep(current, plan, t) : t('workbench.thinking.active'),
    };
  }

  const last = bars.at(-1);
  const starts = bars.map((node) => node.toolStartedAt ?? node.startedAt);
  const ends = bars.map((node) => node.toolEndedAt ?? node.endedAt);
  const known = (values: (number | undefined)[]) =>
    values.filter((value): value is number => value !== undefined);
  const durationMs =
    known(starts).length > 0 && known(ends).length > 0
      ? Math.max(...known(ends)) - Math.min(...known(starts))
      : undefined;
  return {
    ...base,
    // A tool erroring is routine inside an agent loop (the agent reads the error and
    // goes on), so a settled stretch is never an alarm: the count and reason stay
    // on the line as plain information.
    status: 'done',
    durationMs,
    failureReason:
      last?.kind === 'tool' && isWorkbenchToolFailed(last)
        ? presentTool(last, plan, t).errorText
        : undefined,
  };
}
