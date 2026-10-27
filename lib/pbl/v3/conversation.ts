import type { AgentRole } from './domain/project/project-schema';

export type LearningRunFailure = 'authentication' | 'timeout' | 'incomplete' | 'unavailable';

/** Learner-owned conversation with OpenPBL thinking and full tool activity. */
export interface LearningConversationEntry {
  id: string;
  at?: number;
  /** Durable learner input owning this reply, independent of worker attempts and history pages. */
  inputId?: number;
  status?: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  failure?: LearningRunFailure;
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
    | { kind: 'text'; id: string; messageId?: number; text: string; streaming?: boolean }
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
          | 'tool';
        name?: string;
        omitted?: boolean;
        args?: unknown;
        result?: unknown;
        display?: unknown;
        progress?: { kind?: string; text?: string; percent?: number; data?: unknown };
        projectCompleted?: boolean;
        startedAt?: number;
        endedAt?: number;
        status: 'running' | 'succeeded' | 'failed' | 'interrupted';
      }
  )[];
}

/** Fold loaded history fragments by durable identity, without altering cached pages. */
export function mergeConversationHistory(pages: readonly (readonly LearningConversationEntry[])[]) {
  const parts = new Map<string, LearningConversationEntry['parts'][number]>();
  return deduplicateHandoffs(
    pages.flatMap((page) =>
      page.flatMap((entry) => {
        const merged: LearningConversationEntry = { ...entry, parts: [] };
        for (const part of entry.parts) {
          const key = `${part.kind}:${part.id}`;
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

/** Remove only synthesized handoff echoes, preserving the original model reply and its identity. */
export function handoffEchoes<
  T extends {
    scope: string;
    inputId?: number;
    messageId?: number;
    text: string;
    handoff: boolean;
  },
>(replies: readonly T[]): Set<T> {
  const originals = new Map<string, Map<number, string[]>>();
  const key = (reply: T) => `${reply.scope}:${reply.inputId}`;
  for (const reply of replies) {
    if (reply.handoff || reply.inputId === undefined || reply.messageId === undefined) continue;
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
    replies.filter(
      (reply) =>
        reply.handoff &&
        reply.inputId !== undefined &&
        !!reply.text &&
        text.get(key(reply))?.includes(reply.text),
    ),
  );
}

/** Also used after paginated fragments merge, when the original may arrive on an older page. */
export function deduplicateHandoffs(entries: readonly LearningConversationEntry[]) {
  const replies = entries.flatMap((entry) =>
    entry.parts.flatMap((part) =>
      part.kind === 'text'
        ? [
            {
              scope: entry.speaker,
              inputId: entry.inputId,
              messageId: part.messageId,
              text: part.text,
              handoff: part.id.startsWith('question-'),
              part,
            },
          ]
        : [],
    ),
  );
  const duplicates = new Set<LearningConversationEntry['parts'][number]>(
    [...handoffEchoes(replies)].map((reply) => reply.part),
  );
  return entries.flatMap((entry) => {
    const parts = entry.parts.filter((part) => !duplicates.has(part));
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
}
