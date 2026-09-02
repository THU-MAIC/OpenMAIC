// @vitest-environment jsdom

/**
 * One column, one left edge.
 *
 * The transcript and the composer used to establish a column each: their own
 * `px-*` gutter, and their own `mx-auto w-full max-w-*` centering wrapper. Equal
 * padding values were not enough, because the two columns are centered inside
 * DIFFERENT containing blocks — the transcript's is a scroll container, whose
 * content box is narrower than the composer footer's by the scrollbar's width:
 *
 *   transcript text left = pad + (pane - 2*pad - scrollbar - measure) / 2
 *   composer box  left   = pad + (pane - 2*pad             - measure) / 2
 *
 * The padding cancels out of the difference and what remains is `-scrollbar/2`,
 * at EVERY padding value — the transcript half a scrollbar to the left of the
 * composer, which is exactly what tuning the two `px-*` classes against each
 * other failed to move.
 *
 * So both regions spend ONE shared class (`chatColumn`) — the transcript's
 * content wrapper and the composer's wrapper — while the scroll viewport keeps
 * the full pane width so the scrollbar stays on the pane's edge, and the footer
 * cancels the scrollbar difference by reserving the MEASURED scrollbar width as
 * `padding-right`. What is pinned here is that single source: the gutter and
 * the measure live in `chatColumn`, both regions apply the same `column` value,
 * and neither region writes its own `px-*` / `mx-auto` / `max-w-*` beside it.
 * Editing one side back to its own hand-written padding breaks these tests.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chatColumn, wbStyles as styles } from '@/components/workbench/chat/chat-styles';
import { ChatTimeline } from '@/components/workbench/chat/chat-timeline';
import type { ChatNode } from '@/lib/workbench/session-store';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/** Tailwind's spacing unit, so `px-3` can be read as 12px. */
const SPACING_PX = 4;

/** Horizontal insets, ignoring variant-prefixed classes (`data-[…]:px-2.5`). */
const tokens = (classes: string) => classes.split(/\s+/).filter((c) => c && !c.includes(':'));
const horizontalPadding = (classes: string) =>
  tokens(classes).filter((c) => /^(?:px|pl|pr)-/.test(c));
const horizontalMargin = (classes: string) =>
  tokens(classes).filter((c) => /^(?:mx|ml|mr)-/.test(c));
const centering = (classes: string) =>
  tokens(classes).filter((c) => c === 'mx-auto' || c.startsWith('max-w-'));

/**
 * The opening tag carrying `anchor`. Attribute expressions in the chat shell
 * contain no `>` of their own (pinned by the shell using truthiness, not `> 0`,
 * in its one inline style), so the first one after the anchor closes the tag.
 */
function openingTag(source: string, anchor: string): string {
  const at = source.indexOf(anchor);
  expect(at, `anchor ${anchor} in WorkbenchChat.tsx`).toBeGreaterThan(-1);
  return source.slice(source.lastIndexOf('<', at), source.indexOf('>', at) + 1);
}

describe('chatColumn — the single source of the chat gutter', () => {
  it('spends one gutter class on both column modes', () => {
    const full = chatColumn(false);
    const measured = chatColumn(true);

    // Beside the classroom the column IS the pane: the gutter, and nothing else.
    expect(tokens(full)).toHaveLength(1);
    expect(horizontalPadding(full)).toEqual(tokens(full));
    // The full-width conversation adds the reading measure ON TOP of that same
    // gutter — it does not restate it.
    expect(tokens(measured)).toContain(tokens(full)[0]);
    expect(horizontalPadding(measured)).toEqual(horizontalPadding(full));
    expect(centering(measured)).toContain('mx-auto');
  });

  it('caps the column at the reading measure PLUS the gutter on both sides', () => {
    // Moving the gutter out of the two regions and onto the column must not
    // narrow the text: the cap is a border-box width, so it has to carry the
    // gutter it now owns.
    const cap = /max-w-\[(\d+)px\]/.exec(chatColumn(true));
    const pad = /\bpx-(\d+)\b/.exec(chatColumn(false));
    expect(cap, 'the column cap').not.toBeNull();
    expect(pad, 'the column gutter').not.toBeNull();
    expect(Number(cap![1])).toBe(760 + 2 * Number(pad![1]) * SPACING_PX);
  });
});

describe('WorkbenchChat — the transcript and the composer share that column', () => {
  const shell = read('components/workbench/WorkbenchChat.tsx');

  it('spends the one column value on both regions, from one call site', () => {
    expect(shell.match(/chatColumn\(/g), 'chatColumn call sites').toHaveLength(1);

    // The transcript's copy: on the content wrapper inside the scroll viewport,
    // so the viewport itself keeps the full pane width and the scrollbar stays
    // on the pane's edge.
    const content = openingTag(shell, 'ref={contentRef}');
    expect(content, "the transcript's content wrapper spends the column").toContain('column');

    // The composer's copy: on the wrapper inside the footer.
    const composerWrapper = openingTag(shell, "'pointer-events-auto relative'");
    expect(composerWrapper, "the composer's wrapper spends the column").toContain('column');

    // Ordering sanity: viewport before footer inside the shared shell.
    const scrollAt = shell.indexOf('data-testid="workbench-chat-scroll"');
    const footerAt = shell.indexOf('data-testid="workbench-composer-footer"');
    expect(scrollAt).toBeGreaterThan(-1);
    expect(scrollAt).toBeLessThan(footerAt);
  });

  it('cancels the scrollbar with a measured reserve, not a guessed number', () => {
    // The footer reserves the MEASURED scrollbar width, so the two copies of the
    // column center inside boxes of the same width on every platform.
    const footer = openingTag(shell, 'data-testid="workbench-composer-footer"');
    expect(footer).toContain('paddingRight: scrollbarWidth');
    expect(shell).toContain('offsetWidth - el.clientWidth');
  });

  it('writes no hand-written inset or centering beside the shared column', () => {
    const regions = {
      'the scroll viewport': openingTag(shell, 'data-testid="workbench-chat-scroll"'),
      'the timeline content wrapper': openingTag(shell, 'ref={contentRef}'),
      'the composer footer': openingTag(shell, 'data-testid="workbench-composer-footer"'),
      "the composer's wrapper": openingTag(shell, "'pointer-events-auto relative'"),
    };
    for (const [name, tag] of Object.entries(regions)) {
      expect(horizontalPadding(tag), `${name} re-added its own gutter`).toEqual([]);
      expect(horizontalMargin(tag), `${name} re-added a horizontal margin`).toEqual([]);
      expect(centering(tag), `${name} re-added its own centering wrapper`).toEqual([]);
    }
    // The per-region hand-written measure is gone for good: the only centering
    // classes in the file come out of `chatColumn`.
    expect(shell).not.toContain('const measure');
    expect(shell).not.toContain('mx-auto');
  });
});

describe('every timeline row starts on that column edge', () => {
  /**
   * Frameless rows carry no horizontal inset at all: their text IS the column's
   * left edge, alongside the agent's prose.
   */
  const frameless: Record<string, string> = {
    'timeline root': styles.timeline.root,
    'user bubble row': styles.userBubble.row,
    'system notice row': styles.systemNotice.row,
    'run boundary row': styles.boundary.row,
    'waiting bar': styles.waiting.root,
    'handed-over question row': styles.questionCard.summaryBox,
    'course card set': styles.courseLink.set,
    'empty state': styles.emptyState.root,
    'action cluster with a wait': styles.actionCluster.withWait,
  };

  /**
   * Framed rows are bordered boxes, so what lines up is the FRAME. Inner padding
   * is that card's own; a horizontal margin would push the frame off the column.
   */
  const framed: Record<string, string> = {
    'thinking block': styles.thinking.box,
    'tool card': styles.toolCard.box,
    'tool group': styles.toolGroup.group,
    'action cluster': styles.actionCluster.root,
    'question card': styles.questionCard.box,
    'course card': styles.courseLink.block,
  };

  it('gives frameless rows no horizontal inset', () => {
    for (const [name, classes] of Object.entries(frameless)) {
      expect(horizontalPadding(classes), `${name} is indented past the column`).toEqual([]);
      expect(horizontalMargin(classes), `${name} is offset from the column`).toEqual([]);
    }
  });

  it('puts every framed row’s border on the column edge', () => {
    for (const [name, classes] of Object.entries(framed)) {
      expect(horizontalMargin(classes), `${name}'s frame is offset from the column`).toEqual([]);
    }
  });

  it('renders the agent’s prose with no wrapper inset of its own', () => {
    const nodes: ChatNode[] = [
      { key: 'a', kind: 'assistant', text: 'aligned' },
      { key: 's', kind: 'system', text: 'a notice' },
      { key: 'w', kind: 'waiting', text: '' },
    ];
    for (const node of nodes) {
      const host = document.createElement('div');
      host.innerHTML = renderToStaticMarkup(
        createElement(ChatTimeline, { chat: [node], plan: [] }),
      );
      const row = host.firstElementChild?.firstElementChild;
      expect(row, `${node.kind} row`).not.toBeNull();
      const classes = row!.getAttribute('class') ?? '';
      expect(horizontalPadding(classes), `${node.kind} row is indented`).toEqual([]);
      expect(horizontalMargin(classes), `${node.kind} row is offset`).toEqual([]);
    }
  });
});
