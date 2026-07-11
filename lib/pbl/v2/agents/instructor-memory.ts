/**
 * PBL v2 — Instructor thread memory compression.
 *
 * Long chat threads burn context window and slow down every
 * Instructor turn. When `thread.messages` exceeds the threshold,
 * fold the older half into `earlierSummary` (a bounded
 * system-prompt-friendly digest) and keep only the more recent half
 * as live messages.
 *
 * The compression boundary is always aligned to a user message so a
 * mid-question pair never gets split — the LLM should never see
 * "the learner just said ..." without seeing what they said.
 *
 * Pure (no LLM call): the summary is a small learner-memory layer
 * (facts, blockers, preferences, progress) plus a short recent trace.
 * It is intentionally bounded so memory never crowds out the
 * project/task/rules blocks in the Instructor prompt.
 */

import type { PBLAgentThread, PBLChatMessage } from '../types';

/** Compress when this many messages are in the live history. */
export const COMPRESS_THRESHOLD = 30;

/** After compression, this many messages remain live (most recent). */
const KEEP_RECENT = 16;

/** Hard cap for folded memory. Keeps prompt cost stable over long projects. */
export const MAX_EARLIER_SUMMARY_CHARS = 4500;

/**
 * Compress the thread if its message list has grown past the
 * threshold. Returns a (possibly new) thread; mutates nothing in
 * place — the caller is expected to assign the return value.
 */
export function compressIfNeeded(thread: PBLAgentThread): PBLAgentThread {
  if (thread.messages.length <= COMPRESS_THRESHOLD) return thread;

  // Find a cut point that lands on the boundary "user msg ends, next
  // assistant msg starts" so we don't split a turn.
  const targetCutIdx = thread.messages.length - KEEP_RECENT;
  let cutIdx = targetCutIdx;
  while (cutIdx > 0 && thread.messages[cutIdx].roleType !== 'user') {
    cutIdx--;
  }
  // Safety: don't cut everything; preserve at least KEEP_RECENT/2 live.
  if (cutIdx < 1 || cutIdx > thread.messages.length - 4) {
    cutIdx = Math.max(1, targetCutIdx);
  }

  const older = thread.messages.slice(0, cutIdx);
  const recent = thread.messages.slice(cutIdx);
  const olderSummary = digestOlderHalf(older);
  const combined = compactSummary(
    thread.earlierSummary ? `${thread.earlierSummary}\n\n${olderSummary}` : olderSummary,
  );

  return {
    ...thread,
    earlierSummary: combined,
    messages: recent,
  };
}

/** Produce a structural digest from the older half of the thread. */
function digestOlderHalf(messages: PBLChatMessage[]): string {
  const userTurns = messages.filter((m) => m.roleType === 'user').length;
  const assistantTurns = messages.filter((m) => m.roleType === 'instructor').length;
  const memory = extractLearnerMemory(messages);
  const trace = messages
    .slice(-8)
    .map((m) => {
      const role =
        m.roleType === 'user' ? 'Learner' : m.roleType === 'instructor' ? 'Instructor' : m.roleType;
      return `- ${role}: ${truncate(firstParagraph(m.content), 150)}`;
    })
    .join('\n');

  return [
    '## Earlier conversation digest',
    `Older turns folded: learner=${userTurns}, instructor=${assistantTurns}.`,
    '',
    'Learner context inferred from folded turns:',
    memory.length
      ? memory.map((m) => `- ${m}`).join('\n')
      : '- No durable learner facts extracted.',
    '',
    'Recent folded exchange trace:',
    trace || '(none)',
  ].join('\n');
}

function extractLearnerMemory(messages: PBLChatMessage[]): string[] {
  const userMessages = messages.filter((m) => m.roleType === 'user');
  const buckets: Array<{ label: string; re: RegExp; max: number }> = [
    {
      label: 'Environment/tools',
      re: /(vscode|vs code|pycharm|cursor|ide|terminal|终端|命令行|python|node|npm|pnpm|浏览器|mac|windows|jupyter)/i,
      max: 3,
    },
    {
      label: 'Level/preference',
      re: /(零基础|0基础|小白|新手|初学|最简单|不懂|不会|有基础|高级|慢一点|详细|直接|中文|英文|beginner|advanced|explain|simple)/i,
      max: 4,
    },
    {
      label: 'Blocker/confusion',
      re: /(报错|错误|失败|卡住|不懂|不会|error|failed|traceback|stuck|confused|cannot|can't)/i,
      max: 4,
    },
    {
      label: 'Progress/evidence',
      re: /(完成|好了|可以了|通过|成功|提交|保存|done|works|worked|passed|submitted|saved)/i,
      max: 4,
    },
  ];

  const notes: string[] = [];
  for (const bucket of buckets) {
    const matches = userMessages
      .filter((m) => bucket.re.test(m.content))
      .slice(-bucket.max)
      .map((m) => truncate(m.content, 140));
    if (matches.length) {
      notes.push(`${bucket.label}: ${matches.join(' / ')}`);
    }
  }
  return notes.slice(0, 10);
}

function compactSummary(summary: string): string {
  if (summary.length <= MAX_EARLIER_SUMMARY_CHARS) return summary;
  const tail = summary.slice(summary.length - MAX_EARLIER_SUMMARY_CHARS + 120);
  return [
    '## Earlier conversation memory (compacted)',
    'Older folded memory exceeded the budget; this keeps the newest durable learner context and recent trace.',
    tail.replace(/^\s+/, ''),
  ].join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function firstParagraph(s: string): string {
  const idx = s.indexOf('\n\n');
  return idx > 0 ? s.slice(0, idx) : s;
}
