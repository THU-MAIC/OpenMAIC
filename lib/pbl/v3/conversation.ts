import type { AgentRole } from './domain/project/project-schema';

export type LearningRunFailure =
  | 'authentication'
  | 'timeout'
  | 'incomplete'
  | 'unavailable'
  | 'contextCapacity'
  | 'contextTurnCapacity'
  | 'contextPreparation';

/**
 * How a whiteboard or pointer call shows in the conversation: what it did, and what the telling
 * of the reply needs to show it at the right moment. Both kinds of call share the `board`
 * action: they are what the role does beside what it says.
 */
export interface LearningBoardDisplay {
  op:
    | 'text'
    | 'table'
    | 'code'
    | 'shape'
    | 'line'
    | 'latex'
    | 'chart'
    | 'edit'
    | 'delete'
    | 'clear'
    | 'read'
    | 'point'
    | 'open'
    | 'close';
  label: string;
  seq: number | null;
  /** Elements this change put on the board, shown when the telling of the reply reaches it. */
  ids?: string[];
  /** Elements this change took off the board, gone when the telling of the reply reaches it. */
  removes?: string[];
  /** What the role points at while speaking. */
  target?: CodePointer | PreviewPointer;
}

/** Lines of a project file, in a spotlight or under a laser dot. */
export interface CodePointer {
  path: string;
  line: number;
  end?: number;
  pointer: 'spotlight' | 'laser';
}

/** An element of the learner's running application, by CSS selector. */
export interface PreviewPointer {
  selector: string;
  pointer: 'spotlight' | 'laser';
}

/** Learner-owned conversation with OpenPBL thinking and full tool activity. */
export interface LearningConversationEntry {
  id: string;
  at?: number;
  /** Durable learner input owning this reply, independent of worker attempts and history pages. */
  inputId?: number;
  /** Learner send command, used to reconcile its local acknowledgement with HTTP/SSE. */
  commandId?: string;
  /** This turn belongs to the active role and step in the live study view. */
  currentStage?: true;
  status?: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  failure?: LearningRunFailure;
  /** Already delivered words to show in the bubble after a tool-only recovery. */
  restingHandoff?: string;
  omitted?: boolean;
  speaker: 'user' | AgentRole;
  boundary?: {
    milestoneId: string;
    milestoneTitle: string;
    milestoneIndex: number;
    stageIndex: number;
    step: string;
    total: number;
  };
  parts: (
    | {
        kind: 'text';
        id: string;
        messageId?: number;
        text: string;
        streaming?: boolean;
        canonical?: true;
        /** The legacy review receipt requested in the very same assistant message. */
        reviewReceiptId?: string;
        /** A finished prose-only stop can be registered by the next legacy tool-only call. */
        reviewStop?: true;
        /** Original assistant frame, also referenced by a spoken review receipt. */
        spokenAt?: number;
      }
    | {
        kind: 'thinking';
        id: string;
        messageId?: number;
        text: string;
        streaming?: boolean;
        startedAt?: number;
        endedAt?: number;
      }
    | {
        kind: 'tool';
        id: string;
        action:
          | 'read'
          | 'write'
          | 'build'
          | 'collect'
          | 'review'
          | 'complete'
          | 'list'
          | 'manage'
          | 'skill'
          | 'tool'
          | 'board';
        name?: string;
        omitted?: boolean;
        args?: unknown;
        result?: unknown;
        display?: unknown;
        progress?: { kind?: string; text?: string; percent?: number; data?: unknown };
        projectCompleted?: boolean;
        readyForStudentConfirmation?: boolean;
        /** A later successful teaching-control call recovered this failure for the same input. */
        recovered?: boolean;
        startedAt?: number;
        endedAt?: number;
        status: 'running' | 'succeeded' | 'failed' | 'interrupted';
      }
  )[];
}

function conversationScope(entry: LearningConversationEntry): string {
  return entry.id.startsWith('pbl-role-') && entry.id.includes(':')
    ? entry.id.slice(0, entry.id.indexOf(':'))
    : entry.speaker;
}

/** Fold loaded history fragments by durable identity, without altering cached pages. */
export function mergeConversationHistory(pages: readonly (readonly LearningConversationEntry[])[]) {
  const parts = new Map<string, LearningConversationEntry['parts'][number]>();
  return deduplicateHandoffs(
    pages.flatMap((page) =>
      page.flatMap((entry) => {
        const merged: LearningConversationEntry = { ...entry, parts: [] };
        for (const part of entry.parts) {
          const key = `${conversationScope(entry)}:${part.kind}:${part.id}`;
          const earlier = parts.get(key);
          if (earlier) {
            // Pages arrive newest first but are folded chronologically. A later
            // tool result supplies the verdict while retaining earlier arguments.
            Object.assign(earlier, part);
          } else {
            const copy = { ...part };
            parts.set(key, copy);
            merged.parts.push(copy);
          }
        }
        return entry.parts.length && !merged.parts.length ? [] : [merged];
      }),
    ),
  );
}

/** Resolve committed response delivery and legacy exact echoes without changing durable records. */
export function handoffEchoes<
  T extends {
    scope: string;
    inputId?: number;
    messageId?: number;
    text: string;
    handoff: boolean;
    canonical?: boolean;
    spokenAt?: number;
  },
>(replies: readonly T[]): Set<T> {
  const originals = new Map<string, Map<number, string[]>>();
  const canonical = new Map<string, T>();
  const speech = new Map<string, string[]>();
  const key = (reply: T) => `${reply.scope}:${reply.inputId}`;
  for (const reply of replies) {
    if (reply.canonical && reply.inputId !== undefined) canonical.set(key(reply), reply);
    if (reply.handoff || reply.inputId === undefined || reply.messageId === undefined) continue;
    if (reply.spokenAt !== undefined) {
      const frame = `${key(reply)}:${reply.spokenAt}`;
      const words = speech.get(frame) ?? [];
      words.push(reply.text);
      speech.set(frame, words);
    }
    const messages = originals.get(key(reply)) ?? new Map<number, string[]>();
    const blocks = messages.get(reply.messageId) ?? [];
    blocks.push(reply.text);
    messages.set(reply.messageId, blocks);
    originals.set(key(reply), messages);
  }
  const text = new Map(
    [...originals].map(([id, messages]) => [
      id,
      [...messages]
        .sort(([a], [b]) => a - b)
        .map(([, blocks]) => blocks.join('\n'))
        .join('\n\n'),
    ]),
  );
  return new Set(
    replies.filter((reply) => {
      // A spoken receipt only supplies fallback text when its source is outside the loaded page.
      if (reply.handoff && reply.spokenAt !== undefined)
        return (
          speech
            .get(`${key(reply)}:${reply.spokenAt}`)
            ?.some((part) => part.trimEnd().endsWith(reply.text)) ?? false
        );
      const committed = reply.inputId === undefined ? undefined : canonical.get(key(reply));
      if (committed && text.get(key(reply)) !== committed.text)
        return reply !== committed && (reply.handoff || reply.messageId !== undefined);
      return (
        reply.handoff &&
        reply.inputId !== undefined &&
        !!reply.text &&
        text.get(key(reply))?.includes(reply.text)
      );
    }),
  );
}

/** Derive presentation state after live projection or paginated history has been merged. */
export function markRecoveredTeachingTools(entries: readonly LearningConversationEntry[]) {
  const successful = new Set<string>();
  const recovered = new Set<LearningConversationEntry['parts'][number]>();
  for (const entry of [...entries].reverse()) {
    if (entry.inputId === undefined) continue;
    for (const part of [...entry.parts].reverse()) {
      if (part.kind !== 'tool' || !['skill', 'review', 'complete'].includes(part.action)) continue;
      let operation: string = part.action;
      if (part.action === 'skill') {
        // A successful reread does not prove that a failed advancement recovered.
        // Missing legacy arguments cannot establish which operation succeeded.
        if (!part.args || typeof part.args !== 'object' || Array.isArray(part.args)) continue;
        const { studentFeedback } = part.args as { studentFeedback?: unknown };
        // Execution may coerce non-string values; recorded arguments stay original.
        if (studentFeedback !== undefined && typeof studentFeedback !== 'string') continue;
        operation += studentFeedback ? ':advance' : ':read';
      }
      const key = `${conversationScope(entry)}:${entry.inputId}:${operation}`;
      if (part.status === 'succeeded') successful.add(key);
      else if (part.status === 'failed' && successful.has(key)) recovered.add(part);
    }
  }
  return entries.map((entry) => ({
    ...entry,
    parts: entry.parts.map((part) =>
      part.kind === 'tool' ? { ...part, recovered: recovered.has(part) } : part,
    ),
  }));
}

/** Also used after paginated fragments merge, when the original may arrive on an older page. */
export function deduplicateHandoffs(entries: readonly LearningConversationEntry[]) {
  const replies = entries.flatMap((entry) =>
    entry.parts.flatMap((part) =>
      entry.speaker !== 'user' && part.kind === 'text'
        ? [
            {
              scope: conversationScope(entry),
              inputId: entry.inputId,
              messageId: part.messageId,
              text: part.text,
              handoff: part.id.startsWith('question-'),
              canonical: part.canonical,
              spokenAt: part.spokenAt,
              part,
            },
          ]
        : [],
    ),
  );
  // At a whiteboard the role speaks between its board calls and records only the closing in
  // the review tool. Keep the teaching steps at their original positions.
  const boardTurns = new Set(
    entries
      .filter(
        (entry) =>
          entry.inputId !== undefined &&
          entry.parts.some((part) => part.kind === 'tool' && part.action === 'board'),
      )
      .map((entry) => `${conversationScope(entry)}:${entry.inputId}`),
  );
  const spoken = new Set(
    replies
      .filter(
        (reply) =>
          !reply.handoff &&
          reply.inputId !== undefined &&
          boardTurns.has(`${reply.scope}:${reply.inputId}`),
      )
      .map((reply) => reply.part),
  );
  // A legacy recovery call can be on a later attempt or history page. Link it only to the
  // preceding completed stop for this input, never across a file/board operation or user turn.
  const legacySources = new Map<
    string,
    Extract<LearningConversationEntry['parts'][number], { kind: 'text' }>
  >();
  const stops = new Map<
    string,
    Extract<LearningConversationEntry['parts'][number], { kind: 'text' }>
  >();
  for (const entry of entries) {
    if (entry.inputId === undefined || entry.speaker === 'user') continue;
    const turn = `${conversationScope(entry)}:${entry.inputId}`;
    for (const part of entry.parts) {
      if (part.kind === 'text' && !part.id.startsWith('question-')) {
        if (part.reviewReceiptId) legacySources.set(`${turn}:${part.reviewReceiptId}`, part);
        if (part.reviewStop) stops.set(turn, part);
        else stops.delete(turn);
      } else if (part.kind === 'tool' && part.name !== 'cue_user') {
        const stop = stops.get(turn);
        if (stop && part.action === 'review' && part.status === 'succeeded')
          legacySources.set(`${turn}:${part.id.replace(/^tool-/, 'question-')}`, stop);
        stops.delete(turn);
      }
    }
  }
  const recorded = replies.filter((reply) => reply.handoff && reply.spokenAt === undefined);
  const duplicates = new Set<LearningConversationEntry['parts'][number]>();
  const revised = new Map<LearningConversationEntry['parts'][number], string>();
  const boardReceipts = new Set<(typeof replies)[number]>();
  for (const receipt of recorded) {
    if (receipt.inputId === undefined) continue;
    const source = legacySources.get(`${receipt.scope}:${receipt.inputId}:${receipt.part.id}`);
    if (!receipt.canonical && !source) continue;
    const speech = replies.filter(
      (reply) =>
        (spoken.has(reply.part) || (!receipt.canonical && reply.part === source)) &&
        reply.scope === receipt.scope &&
        reply.inputId === receipt.inputId &&
        !reply.handoff,
    );
    if (!speech.length) continue;
    boardReceipts.add(receipt);
    // Keep the original stream position when a recovery receipt copies already spoken words.
    if (speech.some((reply) => reply.text.trimEnd().endsWith(receipt.text.trim()))) {
      duplicates.add(receipt.part);
      continue;
    }
    // Older board agents could author a closing question twice in a single tool-call frame.
    // Preserve the explanation, with the registered question in its original speaking slot.
    let remaining = receipt.text.trim();
    for (const reply of speech) {
      const prefix = reply.text.trim();
      if (prefix && remaining.startsWith(prefix + '\n'))
        remaining = remaining.slice(prefix.length).trimStart();
    }
    if (!remaining) {
      duplicates.add(receipt.part);
      continue;
    }
    if (remaining !== receipt.text.trim()) revised.set(receipt.part, remaining);
    if (!source || !speech.some((reply) => reply.part === source)) continue;
    // The old receipt and prose share a review call but can each carry unique directions.
    // Replace only the last question, keeping preceding sentences from both deliveries.
    const endQuestion = /[?？][*_`"'”’）)\s]*$/u;
    const end = endQuestion.exec(source.text);
    if (!end || !endQuestion.test(remaining)) continue;
    const prefix = source.text.slice(0, end.index);
    let start = 0;
    for (const boundary of prefix.matchAll(/[。！？!?]|\.[ \t]+|\n/gu))
      start = boundary.index + boundary[0].length;
    const intro = source.text.slice(0, start);
    if (intro.trim() && remaining.startsWith(intro.trim() + '\n'))
      remaining = remaining.slice(intro.trim().length).trimStart();
    const merged = intro + remaining;
    // An ambiguous old question may itself contain the only file link or code reference.
    const references =
      source.text.match(
        /\[[^\]]+\]\([^)]*\)|`[^`]+`|[\w/-]+\.[a-z][\w-]*(?::\d+(?:[-–]\d+)?)?/giu,
      ) ?? [];
    if (references.some((reference) => !merged.includes(reference))) continue;
    revised.set(source, merged);
    duplicates.add(receipt.part);
  }
  for (const echo of handoffEchoes(replies)) {
    if (!spoken.has(echo.part) && !boardReceipts.has(echo)) duplicates.add(echo.part);
  }
  const deduplicated = entries.flatMap((entry) => {
    const parts = entry.parts
      .filter((part) => !duplicates.has(part))
      .map((part) => {
        const text = revised.get(part);
        return text !== undefined && part.kind === 'text' ? { ...part, text } : part;
      });
    // The durable handoff owns the resting bubble, even when the worker never wrote a tool card.
    const closing =
      entry.status === 'succeeded' && !parts.some((part) => part.kind === 'text')
        ? entry.parts.findLast((part) => duplicates.has(part) && part.id.startsWith('question-'))
        : undefined;
    if (closing?.kind === 'text') return [{ ...entry, parts, restingHandoff: closing.text }];
    if (
      entry.parts.length &&
      !parts.length &&
      !entry.boundary &&
      !entry.omitted &&
      !['running', 'cancelled', 'interrupted'].includes(entry.status ?? '')
    )
      return [];
    return [{ ...entry, parts }];
  });
  return markRecoveredTeachingTools(deduplicated);
}
