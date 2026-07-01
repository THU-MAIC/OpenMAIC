'use client';

/**
 * Reasoning ("thinking") panel for the editor agent. Renders the model's
 * reasoning (recovered from inline <think> / reasoning_content and split out by
 * extractReasoningMiddleware) as a collapsible block, separate from the answer
 * text, with how long the model spent on THIS block.
 *
 * A multi-step agent reasons several times (read → reason → edit → reason →
 * answer), so a message can hold multiple reasoning blocks. Each gets its own
 * timer keyed `${messageId}:${ordinal}`: an earlier block freezes once a later
 * part follows it; the last block ticks live until something follows or the run
 * finalizes. The ordinal is this block's position among the message's reasoning
 * parts (matched by text), mirroring how the runtime keys the timers.
 */
import { useEffect, useState } from 'react';
import { useMessage } from '@assistant-ui/react';
import { Brain, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useThinkingTimers, formatThinkDuration } from '@/lib/agent/client/thinking-timers';

export function ReasoningPart({ text }: { text: string }) {
  const { t } = useI18n();
  const id = useMessage((m) => m.id);
  const running = useMessage((m) => m.status?.type === 'running');
  // This block's ordinal among the message's reasoning parts. Matched by text,
  // but assistant-ui's text smoothing can momentarily desync the `text` prop from
  // the message snapshot — a -1 there would flip the timer lookup on and off and
  // make the label flicker, so we fall back to the active (last) reasoning block.
  const ordinal = useMessage((m) => {
    const rs = (m.content as Array<{ type: string; text?: string }>).filter(
      (p) => p.type === 'reasoning',
    );
    const i = rs.findIndex((p) => p.text === text);
    return i >= 0 ? i : Math.max(0, rs.length - 1);
  });
  const timer = useThinkingTimers((s) => s.timers[`${id}:${ordinal}`]);
  const [open, setOpen] = useState(false);

  // This block was interrupted if the run ended `incomplete` (stopped/cancelled
  // or errored) while it was the active block — i.e. it's the LAST reasoning
  // block and the final content part (nothing followed it). Earlier blocks that
  // finished before the stop keep their normal "已思考" label.
  const interrupted = useMessage((m) => {
    if (m.status?.type !== 'incomplete') return false;
    const c = m.content as readonly { type: string }[];
    if (c.length === 0 || c[c.length - 1].type !== 'reasoning') return false;
    return c.filter((p) => p.type === 'reasoning').length - 1 === ordinal;
  });

  const startedAt = timer?.startedAt;
  const endedAt = timer?.endedAt;
  // Label is decided by run state + whether the block ended — NOT by timer
  // presence — so a transient missing timer never flips it to "思考过程" mid-run.
  const live = running && endedAt == null;
  const ticking = live && startedAt != null;

  // The live elapsed is driven by a 1s interval into STATE — never recomputed
  // from Date.now() on each render. This component re-renders on every streamed
  // reasoning delta (thousands of times); recomputing the elapsed per render made
  // the counter jump erratically. Now it advances once per second, independent of
  // re-renders, so the number ticks smoothly.
  const [tickMs, setTickMs] = useState(0);
  useEffect(() => {
    if (!ticking || startedAt == null) return;
    // Deliberate one-shot init so the counter shows the right elapsed value
    // before the first 1s tick; the interval below keeps it updated.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTickMs(Date.now() - startedAt);
    const h = setInterval(() => setTickMs(Date.now() - startedAt), 1000);
    return () => clearInterval(h);
  }, [ticking, startedAt]);

  if (!text) return null;

  // While ticking: whole seconds from interval state (calm). When frozen: the
  // precise final duration.
  const dur = ticking
    ? `${Math.max(0, Math.floor(tickMs / 1000))}s`
    : startedAt != null && endedAt != null
      ? formatThinkDuration(endedAt - startedAt)
      : '';
  const word = interrupted
    ? t('edit.agent.stopped')
    : endedAt != null
      ? t('edit.agent.thought')
      : live
        ? t('edit.agent.thinking')
        : t('edit.agent.reasoning');

  return (
    <div
      className={cn(
        'rounded-lg border',
        interrupted
          ? 'border-neutral-200 bg-neutral-50/60 dark:border-neutral-700/60 dark:bg-neutral-800/30'
          : 'border-violet-100/70 bg-violet-50/30 dark:border-violet-500/15 dark:bg-violet-500/[0.04]',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[12px] font-medium transition-colors',
          interrupted
            ? 'text-muted-foreground/70 hover:text-muted-foreground'
            : 'text-[#5b1fa8]/80 hover:text-[#5b1fa8] dark:text-violet-300/80 dark:hover:text-violet-200',
        )}
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <Brain className="size-3 shrink-0" />
        <span className={cn('shrink-0', ticking && 'ai-thinking-shimmer')}>{word}</span>
        {dur ? <span className="shrink-0 tabular-nums opacity-70">{dur}</span> : null}
      </button>
      {open ? (
        <div className="whitespace-pre-wrap break-words border-t border-violet-100/60 px-2.5 py-2 text-[12px] leading-relaxed text-muted-foreground dark:border-violet-500/10">
          {text}
        </div>
      ) : null}
    </div>
  );
}
