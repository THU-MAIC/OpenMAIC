/**
 * System notice presentation — the one place that decides how a lifecycle
 * marker READS, and the one place that knows two adjacent markers can be the
 * same fact reported twice.
 *
 * Two rules, both pure (so a replayed log presents identically to a live one,
 * and neither needs a DOM to be tested):
 *
 *  1. A notice is a summary, optionally a hint (what you can do), optionally a
 *     technical cause. The cause never joins the sentence: the raw provider
 *     string is developer prose, and inlining it turned a failed run into a
 *     console line — the failure text and its retry hint welded into one run-on
 *     sentence, with the two languages' punctuation spliced together.
 *  2. Consecutive identical notices collapse to one row with a count. Each
 *     automatic retry appends its own failure marker, so a provider outage used
 *     to print five byte-identical lines; the count says "five times" without
 *     five rows. The collapse is render-only — the fold keeps every marker, so
 *     the transcript remains a faithful record.
 */
import type { ChatNode, SystemTone } from '@/lib/workbench/session-store';
import { defaultWorkbenchTranslator, type WorkbenchTranslator } from '@/lib/i18n/workbench';

/**
 * `stopped` is the cancel boundary rather than a `SystemTone`: it renders in
 * the centered caption register, not as a left-aligned notice row, but it is
 * the same vocabulary of copy + icon + count, so it presents through here too.
 */
export type NoticeTone = SystemTone | 'stopped';

export interface SystemNotice {
  tone: NoticeTone;
  /** One statement of what happened. Never carries the technical cause. */
  summary: string;
  /** What the user can do next, one clause. */
  hint?: string;
  /** The raw cause, verbatim, for the disclosure. */
  detail?: string;
}

/** Notice-shaped nodes: everything the run says about itself. */
export function isNoticeNode(node: ChatNode): boolean {
  return node.kind === 'system' || node.kind === 'boundary';
}

/**
 * Sentence-final punctuation a UI line does not need. Stripped from the
 * summary and the hint so a copy edit cannot leave a trailing stop or the
 * double stop that concatenation used to produce.
 */
const TRAILING_STOPS = /[。．.,，、;；:：!！?？\s]+$/u;

const oneLine = (value: string): string =>
  value.replace(/\s+/gu, ' ').trim().replace(TRAILING_STOPS, '');

/**
 * The cause keeps its own line breaks (a stack trace is easier to read as
 * one), and only loses surrounding blank space and a dangling separator — the
 * shape of `"gateway 524: "`, accurate and unreadable on its own.
 */
const cleanDetail = (value: string): string => value.trim().replace(/[\s:：]+$/u, '');

export function presentSystemNotice(
  node: ChatNode,
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
): SystemNotice {
  const tone: NoticeTone = node.kind === 'boundary' ? 'stopped' : (node.tone ?? 'info');
  const summary = oneLine(node.copyKey ? t(node.copyKey) : node.text);
  const hint = node.hintCopyKey
    ? oneLine(t(node.hintCopyKey))
    : node.hint
      ? oneLine(node.hint)
      : '';
  const detail = node.detail ? cleanDetail(node.detail) : '';
  return {
    tone,
    summary,
    ...(hint ? { hint } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Are these two markers the same fact? Everything the notice can show has to
 * match — a second failure with a DIFFERENT cause is new information and keeps
 * its own row, however similar the summary looks.
 */
export function isSameNotice(a: ChatNode, b: ChatNode): boolean {
  if (!isNoticeNode(a) || !isNoticeNode(b)) return false;
  return (
    a.kind === b.kind &&
    (a.tone ?? 'info') === (b.tone ?? 'info') &&
    (a.copyKey ?? a.text) === (b.copyKey ?? b.text) &&
    (a.detail ?? '') === (b.detail ?? '') &&
    (a.hintCopyKey ?? a.hint ?? '') === (b.hintCopyKey ?? b.hint ?? '')
  );
}

/** The count badge. `×5` is the recognised idiom; the title spells it out. */
export function repeatLabel(repeat: number): string {
  return `×${repeat}`;
}

export function repeatTitle(
  repeat: number,
  t: WorkbenchTranslator = defaultWorkbenchTranslator,
): string {
  return t('workbench.system.repeated', { count: repeat });
}
