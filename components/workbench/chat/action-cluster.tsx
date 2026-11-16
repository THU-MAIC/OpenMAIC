'use client';

/**
 * One row of the agent's work, whatever it holds: a bar alone keeps its own form, and
 * more than one become an `ActivityGroup`. Routing every size through here gives the row
 * one identity as it grows, so its first bar turning into a group is not a remount.
 */
import type { ChatNode, PlannedPage } from '@/lib/workbench/session-store';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';
import { wbStyles as styles } from './chat-styles';
import { ActivityGroup } from './activity-group';
import { ThinkingBlock } from './thinking-block';
import { ToolCard } from './tool-card';
import { WaitingBar } from './waiting-bar';

export function ActionCluster({
  nodes,
  plan = [],
  ongoing = false,
  t = defaultWorkbenchTranslator,
}: {
  nodes: ChatNode[];
  plan?: PlannedPage[];
  ongoing?: boolean;
  t?: WorkbenchTranslator;
}) {
  const bars = nodes.filter((node) => node.kind !== 'waiting');
  if (bars.length === 0) return nodes.length > 0 ? <WaitingBar t={t} /> : null;
  // A group says it is still working on its own line; the wait is part of that.
  if (bars.length > 1) return <ActivityGroup nodes={nodes} plan={plan} ongoing={ongoing} t={t} />;

  const [bar] = bars;
  const single =
    bar.kind === 'thinking' ? (
      <ThinkingBlock
        text={bar.text}
        streaming={bar.streaming}
        startedAt={bar.startedAt}
        endedAt={bar.endedAt}
        t={t}
      />
    ) : (
      <ToolCard node={bar} plan={plan} t={t} />
    );
  if (nodes.at(-1)?.kind !== 'waiting') return single;
  return (
    <div className={styles.actionCluster.withWait}>
      {single}
      <WaitingBar t={t} />
    </div>
  );
}
