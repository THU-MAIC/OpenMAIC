'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Route,
  Code2,
  GraduationCap,
  ListChecks,
  MessageSquareText,
} from 'lucide-react';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { TextBlock } from '@/components/workbench/chat/text-block';
import { ThinkingBlock } from '@/components/workbench/chat/thinking-block';
import { WaitingBar } from '@/components/workbench/chat/waiting-bar';
import { ToolGroup } from '@/components/workbench/chat/tool-group';
import { UserBubble } from '@/components/workbench/chat/user-bubble';
import type { ChatNode } from '@/lib/workbench/session-store';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningConversationEntry } from '@/lib/pbl/v3/conversation';

// OpenPBL's explicit-send reanchor rule, using the host's existing sticky-scroll implementation.
function FollowSend({ count }: { count: number }) {
  const { scrollToBottom } = useStickToBottomContext();
  const previous = useRef(count);
  useEffect(() => {
    if (previous.current !== count) {
      previous.current = count;
      void scrollToBottom();
    }
  }, [count, scrollToBottom]);
  return null;
}
const accents = {
  mentor: 'border-violet-400/40 text-violet-700 dark:text-violet-300',
  discussion: 'border-sky-400/40 text-sky-700 dark:text-sky-300',
  planner: 'border-emerald-400/40 text-emerald-700 dark:text-emerald-300',
  coder: 'border-amber-400/40 text-amber-700 dark:text-amber-300',
};
const icons = {
  mentor: GraduationCap,
  discussion: MessageSquareText,
  planner: ListChecks,
  coder: Code2,
};
type Part = LearningConversationEntry['parts'][number];
type ToolPart = Extract<Part, { kind: 'tool' }>;
const toolNames = {
  read: 'read_file',
  write: 'write_file',
  build: 'run_build',
  collect: 'collect_build',
  review: 'request_skill_review',
  complete: 'complete_stage',
  list: 'list_files',
  manage: 'manage_file',
  skill: 'read_next_skill',
};
function toolNode(part: ToolPart): ChatNode {
  return {
    key: part.id,
    kind: 'tool',
    text: '',
    toolName: part.name ?? toolNames[part.action],
    toolState:
      part.status === 'running' ? 'running' : part.status === 'succeeded' ? 'done' : 'failed',
    toolDetails: { interrupted: part.status === 'interrupted' },
    toolArgs: part.args,
    toolResultText: part.result,
    toolStartedAt: part.startedAt,
    toolEndedAt: part.endedAt,
  };
}
// Keep the OpenPBL turn order. Only adjacent tool calls form a group; prose/thinking splits it.
function groupParts(parts: Part[]) {
  const groups: (Part | ToolPart[])[] = [];
  for (const part of parts) {
    const previous = groups.at(-1);
    if (part.kind === 'tool') {
      if (Array.isArray(previous)) previous.push(part);
      else groups.push([part]);
    } else groups.push(part);
  }
  return groups;
}
function AgentTurn({ entry }: { entry: LearningConversationEntry }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const role = entry.speaker === 'user' ? 'mentor' : entry.speaker;
  const Icon = icons[role];
  const copyText = entry.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n\n');
  return (
    <article
      className="group/turn min-w-0 space-y-1.5"
      data-testid="pbl-agent-turn"
      data-status={entry.status}
    >
      <div className={`flex items-center gap-2 text-[13px] font-medium ${accents[role]}`}>
        <span className="inline-flex size-[22px] items-center justify-center rounded-full bg-current/10">
          <Icon size={14} />
        </span>
        {t(`pblV3.roles.${role}`)}
      </div>
      <div
        className={`pbl-assistant-bubble min-w-0 space-y-2 rounded-xl rounded-tl-md border-l-2 px-3 py-2.5 ${accents[role]}`}
      >
        {groupParts(entry.parts).map((part) =>
          Array.isArray(part) ? (
            <div key={part[0].id} className="space-y-2">
              <ToolGroup nodes={part.map(toolNode)} t={t} />
              {part.some((tool) => tool.action === 'complete' && tool.status === 'succeeded') && (
                <p className="text-foreground">{t('pblV3.journey.completionHandoff')}</p>
              )}
            </div>
          ) : part.kind === 'thinking' ? (
            <ThinkingBlock
              key={part.id}
              text={part.text}
              streaming={part.streaming}
              startedAt={part.startedAt}
              endedAt={part.endedAt}
              t={t}
            />
          ) : part.kind === 'text' ? (
            <div className="text-foreground" key={part.id}>
              <TextBlock text={part.text} streaming={part.streaming} />
            </div>
          ) : null,
        )}
        {entry.status === 'running' && entry.parts.length === 0 && <WaitingBar t={t} />}
        {(entry.status === 'failed' ||
          entry.status === 'cancelled' ||
          entry.status === 'interrupted') && (
          <p role="status" className="text-xs text-muted-foreground">
            {t(
              `pblV3.run.${entry.status === 'cancelled' ? 'cancelled' : (entry.failure ?? 'unavailable')}`,
            )}
          </p>
        )}
      </div>
      {copyText && (
        <button
          type="button"
          className="rounded p-1 text-muted-foreground opacity-0 hover:text-foreground group-hover/turn:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={t('workbench.chat.copyReply')}
          onClick={() => {
            void navigator.clipboard
              .writeText(copyText)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      )}
    </article>
  );
}
export function LearningConversation({ view, sent }: { view: LearningView; sent: number }) {
  const { t } = useI18n();
  const entries: LearningConversationEntry[] =
    view.conversation ??
    view.messages.map((m, i) => ({
      id: `${i}`,
      speaker: m.role === 'user' ? 'user' : (view.role ?? 'mentor'),
      parts: [{ kind: 'text', id: `${i}`, text: m.text }],
    }));
  return (
    <Conversation className="min-h-0 flex-1 bg-background" aria-label={t('pblV3.learning')}>
      <FollowSend count={sent} />
      <ConversationContent className="gap-5 p-4">
        {!entries.length && !view.busy && (
          <p className="text-sm text-muted-foreground">{t('pblV3.journey.startConversation')}</p>
        )}
        {entries.map((entry) =>
          entry.boundary ? (
            <div
              key={entry.id}
              role="separator"
              className="flex items-center gap-3 py-2 text-[11px] text-muted-foreground"
            >
              <span className="h-px flex-1 bg-border" />
              <Route size={13} />
              <span>
                M{entry.boundary.milestoneIndex + 1} · {entry.boundary.milestoneTitle} ·{' '}
                {entry.boundary.stageIndex + 1}/{entry.boundary.total}{' '}
                {t(`pblV3.journey.steps.${entry.boundary.step}`)}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
          ) : entry.speaker === 'user' ? (
            <UserBubble
              key={entry.id}
              text={entry.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n')}
            />
          ) : (
            <AgentTurn key={entry.id} entry={entry} />
          ),
        )}
        {view.busy && !view.conversation && (
          <AgentTurn
            entry={{ id: 'queued', speaker: view.role ?? 'mentor', status: 'running', parts: [] }}
          />
        )}
      </ConversationContent>
      <ConversationScrollButton aria-label={t('pblV3.journey.latest')} />
    </Conversation>
  );
}
