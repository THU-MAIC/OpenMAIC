'use client';

// Port of OpenPBL's ToolCard/ToolGroup (MoonshotAI/kimi-code, MIT), using host tokens.
// Full input/output/display are plain text; each card starts folded, its group open.
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, List, X } from 'lucide-react';
import type { LearningConversationEntry } from '@/lib/pbl/v3/conversation';
import type { useI18n } from '@/lib/hooks/use-i18n';
import { wbStyles as styles } from '@/components/workbench/chat/chat-styles';
import { StatusDot } from '@/components/workbench/chat/status-dot';
import { formatDurationBetween } from '@/components/workbench/chat/format';
import { formatToolPayload, presentTool } from '@/components/workbench/chat/tool-presentation';

type ToolPart = Extract<LearningConversationEntry['parts'][number], { kind: 'tool' }>;
type Translator = ReturnType<typeof useI18n>['t'];
const names = {
  read: 'read_file',
  write: 'write_file',
  build: 'run_build',
  collect: 'collect_build',
  review: 'request_skill_review',
  complete: 'complete_stage',
  list: 'list_files',
  manage: 'manage_file',
  skill: 'read_next_skill',
  tool: 'tool',
  board: 'tool',
};

/** Same salient-field order and 80-character collapsed preview as OpenPBL. */
function inputSummary(part: ToolPart): string {
  if (
    part.action === 'review' ||
    part.name === 'respond_to_learner' ||
    part.name === 'request_learner_help'
  )
    return '';
  const input = part.args;
  let value = input;
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    value = ['path', 'file', 'command', 'cmd', 'pattern', 'query', 'url']
      .map((key) => record[key])
      .find((item) => typeof item === 'string' && item.length);
    value ??= Object.values(record).find((item) => typeof item === 'string' && item.length);
  }
  const flat = value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function ToolCard({ part, stack, t }: { part: ToolPart; stack: string; t: Translator }) {
  const [open, setOpen] = useState(false);
  const output = formatToolPayload(part.result),
    display = formatToolPayload(part.display);
  const progress = part.progress,
    progressData = formatToolPayload(progress?.data);
  const hasProgress =
    !!progress && !!(progress.text || progress.percent !== undefined || progressData);
  const expandable = part.args != null || !!output || !!display || hasProgress;
  const summary = inputSummary(part);
  // Reuse host labels/icons only; its content-generation disclosure rules do not apply here.
  const { icon: Icon, label } = presentTool(
    { key: part.id, kind: 'tool', text: '', toolName: part.name ?? names[part.action] },
    [],
    t,
  );
  const duration = formatDurationBetween(part.startedAt, part.endedAt);
  const outputLines = output.split('\n'),
    scrollOutput = outputLines.length > 50;
  return (
    <div
      className={styles.toolCard.box}
      data-status={part.status}
      data-stack={stack}
      data-open={open}
      data-testid="workbench-tool-card"
    >
      <button
        type="button"
        className={`${styles.toolCard.head} font-[family-name:var(--wb-font-mono)]`}
        aria-expanded={open}
        disabled={!expandable}
        onClick={() => expandable && setOpen((value) => !value)}
      >
        {part.status === 'succeeded' || part.status === 'failed' ? (
          <span
            className={styles.toolCard.status}
            data-status={part.status === 'succeeded' ? 'ok' : 'error'}
          >
            {part.status === 'succeeded' ? <Check size={13} /> : <X size={13} />}
          </span>
        ) : (
          <StatusDot status={part.status === 'interrupted' ? 'suspended' : 'running'} />
        )}
        <span className={styles.toolCard.icon} aria-hidden="true">
          <Icon size={13} />
        </span>
        <span className={styles.toolCard.text}>
          <span className={styles.toolCard.name}>{label}</span>
          {!open && summary ? (
            <span className={styles.toolCard.arg} title={summary}>
              {summary}
            </span>
          ) : null}
        </span>
        {!open && part.status === 'running' && progress?.text ? (
          <span className="max-w-2/5 shrink-0 truncate text-xs text-muted-foreground">
            {progress.percent !== undefined ? `${Math.round(progress.percent)}% · ` : ''}
            {progress.text}
          </span>
        ) : null}
        {duration ? <time className={styles.toolCard.time}>{duration}</time> : null}
        {expandable ? (
          <span className={styles.toolCard.car} aria-hidden="true">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className={styles.toolCard.body}>
          {part.args != null ? (
            <div className={styles.toolCard.section}>
              <span className={styles.toolCard.sectionLabel}>{t('pblV3.toolDetails.input')}</span>
              <pre className={styles.toolCard.payload}>{formatToolPayload(part.args)}</pre>
            </div>
          ) : null}
          {hasProgress ? (
            <div className={styles.toolCard.section}>
              <span className={styles.toolCard.sectionLabel}>
                {t('pblV3.toolDetails.progress')}
                {progress?.percent !== undefined ? ` · ${Math.round(progress.percent)}%` : ''}
              </span>
              {progress?.text ? (
                <div
                  className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground"
                  data-kind={progress.kind}
                >
                  {progress.text}
                </div>
              ) : null}
              {progressData ? <pre className={styles.toolCard.payload}>{progressData}</pre> : null}
            </div>
          ) : null}
          {output ? (
            <div className={styles.toolCard.section}>
              <span className={styles.toolCard.sectionLabel}>
                {t(
                  part.status === 'failed'
                    ? 'workbench.tool.section.error'
                    : 'pblV3.toolDetails.output',
                )}
              </span>
              <div
                className={`${styles.toolCard.payload} ${scrollOutput ? 'max-h-[420px] overflow-y-auto' : ''} ${part.status === 'failed' ? 'text-[var(--wb-danger)]' : ''}`}
                data-scroll={scrollOutput || undefined}
                data-error={part.status === 'failed' || undefined}
              >
                {outputLines.map((line, index) => (
                  <div key={index}>{line || '\u00a0'}</div>
                ))}
              </div>
            </div>
          ) : null}
          {display ? (
            <div className={styles.toolCard.section}>
              <span className={styles.toolCard.sectionLabel}>{t('pblV3.toolDetails.display')}</span>
              <pre className={styles.toolCard.payload}>{display}</pre>
            </div>
          ) : null}
          {part.omitted && (
            <p className="text-xs text-muted-foreground">{t('pblV3.conversationLimited')}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ToolActivity({ tools, t }: { tools: ToolPart[]; t: Translator }) {
  if (!tools.length) return null;
  if (tools.length === 1) return <ToolCard part={tools[0]} stack="single" t={t} />;
  const completed = tools.every((part) => part.status !== 'running');
  return <ToolActivityGroup key={String(completed)} tools={tools} t={t} completed={completed} />;
}

function ToolActivityGroup({
  tools,
  t,
  completed,
}: {
  tools: ToolPart[];
  t: Translator;
  completed: boolean;
}) {
  const [open, setOpen] = useState(!completed);
  const failed = tools.filter((tool) => tool.status === 'failed').length;
  const status = !completed
    ? 'running'
    : failed
      ? 'error'
      : tools.some((tool) => tool.status === 'interrupted')
        ? 'cancelled'
        : 'done';
  return (
    <div className={styles.toolGroup.group} data-open={open} data-testid="workbench-tool-group">
      <button
        type="button"
        className={`${styles.toolGroup.head} font-[family-name:var(--wb-font-mono)]`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <StatusDot status={status === 'cancelled' ? 'suspended' : status} />
        <span className={styles.toolGroup.icon} aria-hidden="true">
          <List size={13} />
        </span>
        <span className={styles.toolGroup.title}>
          {t('workbench.tool.group.tools', { count: tools.length })}
        </span>
        <span className={styles.toolGroup.meta}>
          ·{' '}
          {status === 'error'
            ? t('workbench.tool.group.failed', { count: failed })
            : status === 'cancelled'
              ? t('pblV3.toolDetails.stopped')
              : status === 'running'
                ? t('pblV3.activity.running')
                : t('workbench.tool.group.done')}
        </span>
        <span className={styles.toolGroup.car} aria-hidden="true">
          <ChevronRight size={13} />
        </span>
      </button>
      {open ? (
        <div className={styles.toolGroup.body}>
          {tools.map((tool, index) => (
            <ToolCard
              key={tool.id}
              part={tool}
              stack={index === 0 ? 'first' : index === tools.length - 1 ? 'last' : 'middle'}
              t={t}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Tool calls as the speech bubble shows them: under the words they follow, one light line
 * each in the bubble's own type, with the same name and icon the conversation gives them.
 * One call is in view at a time; the newest rolls into place and the rest scroll.
 */
export function BubbleTools({ tools, t }: { tools: readonly ToolPart[]; t: Translator }) {
  // One line is in view: each new call rolls up into it, and the earlier ones are a scroll
  // away. Only a new call moves the line, so scrolling back to read is left alone.
  const list = useRef<HTMLUListElement>(null);
  const count = tools.length;
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [count]);
  if (!count) return null;
  return (
    <ul
      ref={list}
      data-testid="pbl-bubble-tools"
      className="flex h-6 snap-y snap-mandatory flex-col overflow-y-auto overscroll-contain scrollbar-hide"
    >
      {tools.map((part) => {
        const { icon: Icon, label } = presentTool(
          { key: part.id, kind: 'tool', text: '', toolName: part.name ?? names[part.action] },
          [],
          t,
        );
        // A whiteboard call is named by what it puts on the board, not by its tool name or
        // the first argument it happens to carry.
        const drawn =
          part.action === 'board'
            ? (part.display as { op?: string; label?: string } | undefined)
            : undefined;
        const name = drawn?.op
          ? `${t('whiteboard.title')} · ${t(`pblV3.board.ops.${drawn.op}`)}`
          : label;
        const summary = drawn ? (drawn.label ?? '') : inputSummary(part);
        const running = part.status === 'running';
        return (
          <li
            key={part.id}
            data-status={part.status}
            className="flex h-6 min-w-0 shrink-0 snap-start items-center gap-2 text-[13px] leading-6 text-gray-500 dark:text-gray-400"
          >
            <span className="grid size-4 shrink-0 place-items-center">
              {running ? (
                <span className="size-3 animate-spin rounded-full border-[1.5px] border-purple-300 border-t-purple-600 dark:border-purple-700 dark:border-t-purple-300" />
              ) : part.status === 'succeeded' ? (
                <Check size={13} className="text-emerald-500" />
              ) : (
                <X size={13} className="text-red-500" />
              )}
            </span>
            <Icon size={13} className="shrink-0 opacity-70" aria-hidden="true" />
            <span
              className={`shrink-0 ${running ? 'font-medium text-gray-800 dark:text-gray-100' : ''}`}
            >
              {name}
            </span>
            {summary ? <span className="truncate opacity-70">{summary}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
