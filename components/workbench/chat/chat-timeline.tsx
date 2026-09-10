'use client';

/**
 * Chat timeline — the folded chat as render rows.
 *
 * One grouping rule, computed on render (no grouping state is stored, so a
 * replayed log groups identically to a live one): consecutive action bars
 * (thinking, tools, the pre-token wait) share one stack, then split per
 * kind-run for render — a consecutive tool run keeps its `ToolGroup`
 * aggregate ("N tool calls") even when a thinking bar sits next to it, and
 * thinking bars render as their own rows. Consecutive identical system notices
 * collapse the same way, into one row with a count.
 *
 * Single-agent layout, after the PR5 supervision-layer removal: the
 * assistant's prose floats (no container), actions (tool cards, thinking
 * bars) are boxed, the user is a solid right-side bubble, and system markers
 * are a small icon with one muted line (a tinted notice card when they carry a
 * failure). There are deliberately no skill announcements and no
 * constraint-violation chips — the agent says what it picked in prose, and
 * machine-check results stay in tool results for the agent.
 *
 * The one row that is not a record of something that happened is the `ask_user`
 * question card: it is a hand-over, so it gets its own line and the host's send
 * path (`onAnswer`).
 */
import { CircleSlash2 } from 'lucide-react';
import type { ChatNode, PlannedPage } from '@/lib/workbench/session-store';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';
import { wbStyles as styles } from './chat-styles';
import { ActionCluster } from './action-cluster';
import { SessionCourseLink } from './course-link';
import { QuestionCard } from './question-card';
import { SystemNode } from './system-node';
import { isSameNotice, presentSystemNotice, repeatLabel, repeatTitle } from './system-notice';
import { TextBlock } from './text-block';
import { ThinkingBlock } from './thinking-block';
import { ToolGroup } from './tool-group';
import { UserBubble } from './user-bubble';
import { WaitingBar } from './waiting-bar';
import { isHiddenWorkbenchTool, isSkillLoadTool } from './tool-presentation';

interface ChatRow {
  key: string;
  node?: ChatNode;
  group?: ChatNode[];
  /**
   * How many identical consecutive system notices this row stands for (1 for
   * every other row). Computed here rather than folded: the timeline data keeps
   * every marker, so a replay re-derives the same count instead of inheriting a
   * collapsed history.
   */
  repeat?: number;
}

function isActionBar(node: ChatNode): boolean {
  return node.kind === 'tool' || node.kind === 'thinking' || node.kind === 'waiting';
}

export function groupChat(chat: ChatNode[]): ChatRow[] {
  const rows: ChatRow[] = [];
  let run: ChatNode[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) rows.push({ key: run[0].key, node: run[0] });
    else rows.push({ key: `g-${run[0].key}`, group: run });
    run = [];
  };
  for (const node of chat) {
    if (node.kind === 'tool' && isHiddenWorkbenchTool(node.toolName)) continue;
    if (isActionBar(node)) {
      run.push(node);
      continue;
    }
    flush();
    // A retry loop appends one failure marker per attempt, so five attempts
    // against the same broken provider used to print five byte-identical rows.
    // Same notice, back to back → one row carrying the count (see
    // `isSameNotice`: a different cause is different news and keeps its row).
    const prev = rows.at(-1);
    if (prev?.node && isSameNotice(prev.node, node)) {
      prev.repeat = (prev.repeat ?? 1) + 1;
      continue;
    }
    rows.push({ key: node.key, node });
  }
  flush();
  return rows;
}

/**
 * Hidden tools leave thinking bars adjacent. Each tool-call turn also mints
 * its own bar. Collapse a run of thinking into one: keep the latest text,
 * span startedAt..endedAt so the duration is the whole stretch.
 *
 * One hard bound from the timing contract: a bar whose duration is already
 * frozen (ended, not streaming) must never be merged with a still-streaming
 * one — the merged bar would inherit the frozen number and then KEEP GROWING
 * when the streaming side settles, i.e. a finished bar's duration changing
 * after the fact. Streaming merges with streaming, frozen with frozen.
 */
export function collapseAdjacentThinking(nodes: ChatNode[]): ChatNode[] {
  const out: ChatNode[] = [];
  for (const node of nodes) {
    const prev = out.at(-1);
    if (
      node.kind === 'thinking' &&
      prev?.kind === 'thinking' &&
      Boolean(node.streaming) === Boolean(prev.streaming)
    ) {
      out[out.length - 1] = {
        ...node,
        key: prev.key,
        startedAt: prev.startedAt ?? node.startedAt,
        endedAt: node.endedAt ?? prev.endedAt,
        streaming: node.streaming || prev.streaming,
      };
      continue;
    }
    out.push(node);
  }
  return out;
}

/**
 * Consecutive action bars share a cluster, then split per run kind: thinking,
 * skill loads (`read` of SKILL.md), and ordinary tools. A tool run still
 * renders as ONE `ToolGroup` ("N tool calls") even when a thinking bar sits
 * next to it; skill loads stay in their own run so they are never folded into
 * that aggregate. Waiting stays glued to the stretch it follows.
 */
function actionRunKey(node: ChatNode): string {
  if (node.kind === 'tool' && isSkillLoadTool(node)) return 'skill';
  return node.kind;
}

export function rowsForRender(chat: ChatNode[]): ChatRow[] {
  const rows: ChatRow[] = [];
  for (const row of groupChat(chat)) {
    if (!row.group) {
      rows.push(row);
      continue;
    }
    const runs: ChatNode[][] = [];
    let run: ChatNode[] = [];
    const flush = () => {
      if (run.length > 0) runs.push(run);
      run = [];
    };
    for (const node of row.group) {
      const prev = run.at(-1);
      // Waiting is the pre-token gap indicator for the stretch that just
      // played, so it stays attached to that stretch instead of becoming a
      // row of its own.
      if (
        node.kind !== 'waiting' &&
        prev !== undefined &&
        actionRunKey(prev) !== actionRunKey(node)
      ) {
        flush();
      }
      run.push(node);
    }
    flush();
    for (const r of runs) {
      const group = collapseAdjacentThinking(r);
      if (group.length === 0) continue;
      if (group.length === 1) rows.push({ key: group[0].key, node: group[0] });
      else rows.push({ key: `g-${group[0].key}`, group });
    }
  }
  return rows;
}

/** Send an answer to an `ask_user` question as a user message. */
export type ChatAnswerHandler = (text: string) => Promise<boolean>;

/**
 * The cancel caption. Centered and faint — the run stopped because the user
 * said so, so it is a receipt, not a warning: an icon, one clause, and a count
 * if a stop was repeated back to back.
 */
function RunBoundary({
  node,
  repeat,
  t,
}: {
  node: ChatNode;
  repeat: number;
  t: WorkbenchTranslator;
}) {
  const notice = presentSystemNotice(node, t);
  return (
    <div className={styles.boundary.row} data-testid="workbench-run-boundary">
      <span className={styles.boundary.inner}>
        <span className={styles.boundary.icon} aria-hidden="true">
          <CircleSlash2 size={11} />
        </span>
        <span>{notice.summary}</span>
        {repeat > 1 ? (
          <span
            className={styles.boundary.count}
            title={repeatTitle(repeat, t)}
            aria-label={repeatTitle(repeat, t)}
          >
            {repeatLabel(repeat)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function ChatNodeView({
  node,
  plan,
  onAnswer,
  onRevive,
  collapsedQuestion = false,
  repeat = 1,
  t,
}: {
  node: ChatNode;
  plan: PlannedPage[];
  onAnswer?: ChatAnswerHandler;
  onRevive?: () => void;
  collapsedQuestion?: boolean;
  repeat?: number;
  t: WorkbenchTranslator;
}) {
  switch (node.kind) {
    case 'user':
      return (
        <UserBubble
          text={node.text}
          materials={node.materials}
          elementRefs={node.elementRefs}
          courseRefs={node.courseRefs}
        />
      );
    case 'system':
      return <SystemNode node={node} repeat={repeat} t={t} />;
    case 'question':
      // The agent is waiting on the user. Its own row, never inside an action
      // cluster: a question is not something the agent DID, it is a hand-over.
      return (
        <QuestionCard
          node={node}
          onAnswer={onAnswer}
          onRevive={onRevive}
          collapsed={collapsedQuestion}
          t={t}
        />
      );
    case 'boundary':
      return <RunBoundary node={node} repeat={repeat} t={t} />;
    case 'thinking':
      return (
        <ThinkingBlock
          text={node.text}
          streaming={node.streaming}
          startedAt={node.startedAt}
          endedAt={node.endedAt}
          t={t}
        />
      );
    case 'tool':
      return <ToolGroup nodes={[node]} plan={plan} t={t} />;
    case 'course':
      // The tail of one exchange (question → answer): the classrooms it
      // produced or was pointed at, one card each, the rest behind a `+N`. The
      // row carries that answer's own ordered set; an empty one is the legacy
      // unbound row and SessionCourseLink falls back to the session's own stage.
      return <SessionCourseLink stageIds={node.stageIds} />;
    case 'waiting':
      // The LLM-gap indicator: open between "the agent owes an answer" and
      // the first content; the fold removes it when content arrives.
      return <WaitingBar t={t} />;
    default:
      // The agent's own words are a text stream, with no container at all.
      // Tool cards keep their frame precisely because they are NOT speech —
      // they are operations — and the distinction is carried by the strongest
      // visual difference the rail has: prose floats, actions are boxed.
      // Streaming is quiet: no caret anywhere (PR walkthrough).
      return (
        <div className="text-[var(--wb-text)]">
          <TextBlock text={node.text} streaming={node.streaming} />
        </div>
      );
  }
}

export function ChatTimeline({
  chat,
  plan,
  onAnswer,
  dismissedQuestionKey,
  onReviveQuestion,
  takenOverQuestionKey,
  t = defaultWorkbenchTranslator,
}: {
  chat: ChatNode[];
  plan: PlannedPage[];
  /**
   * The host's send path, handed to question cards so a clicked option travels
   * the SAME route as a typed message (optimistic STOP state included) instead
   * of a private POST beside it.
   */
  onAnswer?: ChatAnswerHandler;
  /**
   * The question whose composer form the user waved off, if any. That card — and
   * only that card — grows the way back to the form; every other question row is
   * unaware the form exists.
   */
  dismissedQuestionKey?: string | null;
  onReviveQuestion?: () => void;
  /**
   * The question whose form currently owns the composer. That row collapses to a
   * one-line pointer at the form, so the question and its options are on the
   * screen exactly once (see `question-card.tsx`).
   */
  takenOverQuestionKey?: string | null;
  t?: WorkbenchTranslator;
}) {
  const rows = rowsForRender(chat);
  return (
    <div className={styles.timeline.root}>
      {rows.map((row) =>
        row.group ? (
          <ActionCluster key={row.key} nodes={row.group} plan={plan} t={t} />
        ) : (
          <ChatNodeView
            key={row.key}
            node={row.node!}
            plan={plan}
            repeat={row.repeat}
            t={t}
            onAnswer={onAnswer}
            collapsedQuestion={
              Boolean(takenOverQuestionKey) && row.node!.key === takenOverQuestionKey
            }
            onRevive={
              row.node!.key === dismissedQuestionKey && onReviveQuestion
                ? onReviveQuestion
                : undefined
            }
          />
        ),
      )}
    </div>
  );
}
