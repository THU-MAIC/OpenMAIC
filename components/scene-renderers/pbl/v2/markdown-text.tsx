'use client';

/**
 * PBL v2 — Markdown text renderer.
 *
 * Thin wrapper around `streamdown` (the same markdown renderer
 * OpenMAIC uses for AI-element messages) so Instructor replies,
 * milestone scripts, and document content render with consistent
 * typography and code formatting.
 */

import { Streamdown } from 'streamdown';
import { cn } from '@/lib/utils/cn';

interface Props {
  readonly content: string;
  readonly className?: string;
}

export function MarkdownText({ content, className }: Props) {
  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none',
        'prose-p:my-2 prose-pre:my-2 prose-headings:mt-3 prose-headings:mb-1',
        'prose-a:text-primary prose-strong:text-foreground prose-li:marker:text-muted-foreground',
        'prose-code:before:content-none prose-code:after:content-none',
        'prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:bg-white/10 prose-code:text-violet-100',
        'prose-pre:bg-zinc-950 prose-pre:text-zinc-100 prose-pre:p-3 prose-pre:rounded-md',
        'prose-pre:overflow-x-auto',
        '[&_div[data-streamdown=code-block]]:relative [&_div[data-streamdown=code-block]]:my-2 [&_div[data-streamdown=code-block]]:gap-0',
        '[&_div[data-streamdown=code-block]]:overflow-hidden [&_div[data-streamdown=code-block]]:rounded-lg [&_div[data-streamdown=code-block]]:border-border/70',
        '[&_div[data-streamdown=code-block]]:bg-zinc-950 [&_div[data-streamdown=code-block]]:p-0',
        '[&_div[data-streamdown=code-block-header]]:absolute [&_div[data-streamdown=code-block-header]]:left-3 [&_div[data-streamdown=code-block-header]]:top-2',
        '[&_div[data-streamdown=code-block-header]]:z-10 [&_div[data-streamdown=code-block-header]]:h-auto [&_div[data-streamdown=code-block-header]]:text-[11px]',
        '[&_div[data-streamdown=code-block-header]]:text-zinc-400 [&_div[data-streamdown=code-block-header]>span]:ml-0',
        '[&_*:has(>div[data-streamdown=code-block-actions])]:!static [&_*:has(>div[data-streamdown=code-block-actions])]:!m-0',
        '[&_*:has(>div[data-streamdown=code-block-actions])]:!h-0 [&_*:has(>div[data-streamdown=code-block-actions])]:!p-0',
        '[&_div[data-streamdown=code-block-actions]]:!absolute [&_div[data-streamdown=code-block-actions]]:!bottom-1.5 [&_div[data-streamdown=code-block-actions]]:!right-1.5',
        '[&_div[data-streamdown=code-block-actions]]:!rounded-md [&_div[data-streamdown=code-block-actions]]:!border-white/10 [&_div[data-streamdown=code-block-actions]]:!bg-zinc-900/85 [&_div[data-streamdown=code-block-actions]]:!text-zinc-300',
        '[&_div[data-streamdown=code-block-body]]:!min-h-[76px] [&_div[data-streamdown=code-block-body]]:!rounded-none [&_div[data-streamdown=code-block-body]]:!border-0',
        '[&_div[data-streamdown=code-block-body]]:!bg-transparent [&_div[data-streamdown=code-block-body]]:!px-3 [&_div[data-streamdown=code-block-body]]:!pb-10 [&_div[data-streamdown=code-block-body]]:!pt-8',
        '[&_div[data-streamdown=code-block-body]]:!text-[13px] [&_div[data-streamdown=code-block-body]]:!text-zinc-100',
        // streamdown ships the code body as `overflow-hidden`, so a long line is
        // clipped on the right with no way to reach it. Make the body (and its
        // <pre>) scroll horizontally instead; keep the vertical axis clipped so
        // the box height is unchanged. The absolutely-positioned header / copy
        // button anchor to the outer code-block, so they stay put while scrolling.
        '[&_div[data-streamdown=code-block-body]]:!overflow-x-auto [&_div[data-streamdown=code-block-body]]:!overflow-y-hidden',
        '[&_div[data-streamdown=code-block-body]>pre]:!m-0 [&_div[data-streamdown=code-block-body]>pre]:!overflow-x-auto [&_div[data-streamdown=code-block-body]>pre]:!bg-transparent [&_div[data-streamdown=code-block-body]>pre]:!text-zinc-100',
        '[&_div[data-streamdown=code-block-body]_code]:!text-zinc-100 [&_div[data-streamdown=code-block-body]_span]:!text-zinc-100',
        className,
      )}
    >
      <Streamdown>{content}</Streamdown>
    </div>
  );
}
