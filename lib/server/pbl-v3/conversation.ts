import 'server-only';
import type { PersistedAgentSessionEvent } from '@openmaic/storage';
import type { AgentRole } from '@/lib/pbl/v3/domain/project/project-schema';
import type { LearningConversationEntry, LearningRunFailure } from '@/lib/pbl/v3/conversation';
import { deduplicateHandoffs } from '@/lib/pbl/v3/conversation';
import { LEARNER_HANDOFF_EVENT, reviewQuestions } from './review-question';
import { CONVERSATION_BYTES } from './conversation-history';
import {
  executionFailureCode,
  AGENT_EXECUTION_IDLE_TIMEOUT,
  MODEL_REQUEST_IDLE_TIMEOUT,
} from '@/lib/agent/runtime/request-failure';

/** Never send provider diagnostics, addresses or credentials to a learner. */
export function learningRunFailure(error: unknown): LearningRunFailure {
  const message = typeof error === 'string' ? error : '';
  if (
    [MODEL_REQUEST_IDLE_TIMEOUT, AGENT_EXECUTION_IDLE_TIMEOUT].includes(
      executionFailureCode(message) ?? '',
    )
  )
    return 'timeout';
  if (message.startsWith('Teaching turn ended without recording')) return 'incomplete';
  return /\b(401|403)\b|unauthori[sz]ed|authentication|api.?key/i.test(message)
    ? 'authentication'
    : /timed?\s*out|timeout|deadline/i.test(message)
      ? 'timeout'
      : 'unavailable';
}

type Part = LearningConversationEntry['parts'][number];
type ToolPart = Extract<Part, { kind: 'tool' }>;
const visibleTools = {
  read_file: 'read',
  write_file: 'write',
  run_build: 'build',
  collect_build: 'collect',
  request_skill_review: 'review',
  complete_stage: 'complete',
  list_files: 'list',
  manage_file: 'manage',
  read_next_skill: 'skill',
} as const;
const runEvents = new Set([
  'session_start',
  'session_resumed',
  'session_end',
  'session_interrupted',
  'thinking_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  LEARNER_HANDOFF_EVENT,
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** Fold durable Pi snapshots in content order, sharing the host's presentation components. */
export function projectConversation(
  events: PersistedAgentSessionEvent[],
  role: AgentRole,
  running: boolean,
  terminalStatus?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'missing',
  history = false,
): LearningConversationEntry[] {
  const entries: LearningConversationEntry[] = [];
  let assistant: LearningConversationEntry | undefined;
  let attempt: number | undefined;
  let messageId: number | undefined;
  let inputId: number | undefined;
  const blocks = new Map<number, Extract<Part, { kind: 'text' | 'thinking' }>>();
  const tools = new Map<string, ToolPart>();
  const questions = reviewQuestions(events);
  const settleThinking = (ts: number) => {
    for (const part of blocks.values())
      if (part.kind === 'thinking') {
        part.streaming = false;
        part.endedAt ??= ts;
      }
  };
  const settle = (ts: number) => {
    settleThinking(ts);
    for (const part of blocks.values()) part.streaming = false;
    for (const tool of tools.values())
      if (tool.status === 'running') {
        tool.status = 'interrupted';
        tool.endedAt ??= ts;
      }
    blocks.clear();
    tools.clear();
    messageId = undefined;
  };
  const getAssistant = (event: Pick<PersistedAgentSessionEvent, 'id' | 'ts'>) => {
    if (!assistant) {
      assistant = {
        id: `turn-${event.id}`,
        at: event.ts,
        inputId,
        speaker: role,
        status: 'running',
        parts: [],
      };
      entries.push(assistant);
    }
    return assistant;
  };
  const appendQuestion = (event: PersistedAgentSessionEvent) => {
    const question = questions.get(event.id);
    if (
      question &&
      !getAssistant(event).parts.some(
        (part) => part.kind === 'text' && part.text.includes(question),
      )
    )
      getAssistant(event).parts.push({
        kind: 'text',
        id:
          typeof record(event.data).toolCallId === 'string'
            ? `question-${event.attempt}-${record(event.data).toolCallId}`
            : `question-${event.id}`,
        text: question,
      });
  };
  for (const event of events) {
    const data = record(event.data);
    if (
      typeof data.pblInputId === 'number' &&
      Number.isSafeInteger(data.pblInputId) &&
      data.pblInputId > 0
    )
      inputId = data.pblInputId;
    if (data.pblContentOmitted) getAssistant(event).omitted = true;
    if (event.type === 'pbl_stage_entered') {
      settle(event.ts);
      assistant = undefined;
      attempt = undefined;
      inputId = undefined;
      entries.push({
        id: `stage-${event.id}`,
        at: event.ts,
        speaker: role,
        parts: [],
        boundary: event.data as LearningConversationEntry['boundary'],
      });
      continue;
    }
    if (event.type === 'user_message') {
      inputId = event.id;
      settle(event.ts);
      if (assistant?.status === 'running') assistant.status = 'succeeded';
      assistant = undefined;
      attempt = undefined;
      if (!data.pblOpening && typeof data.text === 'string')
        entries.push({
          id: `user-${event.id}`,
          commandId: typeof data.pblCommandId === 'string' ? data.pblCommandId : undefined,
          at: event.ts,
          speaker: 'user',
          parts: [{ kind: 'text', id: `${event.id}`, text: data.text }],
        });
      getAssistant(event);
      continue;
    }
    // Control-plane messages have attempt 0 (or the previous generation for
    // automatic openings). Their waiting turn belongs to the NEXT worker run.
    // Only run events can establish or interrupt an execution attempt.
    if (!runEvents.has(event.type)) continue;
    if (attempt !== undefined && event.attempt !== attempt) {
      settle(event.ts);
      if (assistant?.status === 'running') assistant.status = 'interrupted';
      assistant = undefined;
    }
    attempt = event.attempt;
    if (event.type === LEARNER_HANDOFF_EVENT) {
      appendQuestion(event);
      continue;
    }
    if (event.type === 'session_start' || event.type === 'session_resumed') {
      getAssistant(event);
      continue;
    }
    if (event.type === 'session_end' || event.type === 'session_interrupted') {
      settle(event.ts);
      getAssistant(event).status =
        event.type === 'session_interrupted'
          ? 'interrupted'
          : data.status === 'failed' || data.status === 'cancelled'
            ? data.status
            : 'succeeded';
      if (data.status === 'failed') getAssistant(event).failure = learningRunFailure(data.error);
      assistant = undefined;
      continue;
    }
    if (event.type === 'thinking_end') {
      settleThinking(event.ts);
      continue;
    }
    const message = record(data.message);
    if (
      ['message_start', 'message_update', 'message_end'].includes(event.type) &&
      message.role === 'assistant'
    ) {
      const anchor =
        typeof data.pblMessageId === 'number' && data.pblMessageId > 0
          ? data.pblMessageId
          : undefined;
      if (event.type === 'message_start' || (anchor !== undefined && anchor !== messageId)) {
        settleThinking(event.ts);
        for (const part of blocks.values()) part.streaming = false;
        blocks.clear();
        messageId = anchor ?? event.id;
      }
      messageId ??= event.id;
      const content = Array.isArray(message.content) ? message.content : [];
      for (const [index, raw] of content.entries()) {
        const block = record(raw);
        if (block.type !== 'text' && block.type !== 'thinking') continue;
        const text = block.type === 'thinking' ? block.thinking : block.text;
        if (typeof text !== 'string' || !text) continue;
        let part = blocks.get(index);
        if (!part) {
          if (block.type === 'text') settleThinking(event.ts);
          part =
            block.type === 'thinking'
              ? {
                  kind: 'thinking',
                  id: `thinking-${messageId}-${index}`,
                  messageId,
                  text,
                  startedAt: event.ts,
                }
              : { kind: 'text', id: `text-${messageId}-${index}`, messageId, text };
          blocks.set(index, part);
          getAssistant(event).parts.push(part);
        }
        if (part.kind === 'thinking') {
          const timing = record(record(data.pblThinkingTimings)[index]);
          if (typeof timing.startedAt === 'number') part.startedAt = timing.startedAt;
          if (typeof timing.endedAt === 'number') part.endedAt = timing.endedAt;
        }
        part.text = text;
        part.streaming =
          event.type !== 'message_end' && (part.kind !== 'thinking' || part.endedAt === undefined);
      }
      if (event.type === 'message_end') {
        settleThinking(event.ts);
        for (const part of blocks.values()) part.streaming = false;
        blocks.clear();
        messageId = undefined;
      }
    }
    if (
      ['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type)
    ) {
      settleThinking(event.ts);
      const name = String(data.toolName ?? '');
      const action = visibleTools[name as keyof typeof visibleTools] ?? 'tool';
      if (name && typeof data.toolCallId === 'string') {
        let tool = tools.get(data.toolCallId);
        if (!tool) {
          tool = {
            kind: 'tool',
            id: `tool-${event.attempt}-${data.toolCallId}`,
            name,
            action,
            status: 'running',
            ...(event.type === 'tool_execution_start' ? { startedAt: event.ts } : {}),
          };
          tools.set(data.toolCallId, tool);
          getAssistant(event).parts.push(tool);
        }
        if (data.pblContentOmitted) tool.omitted = true;
        if (data.args !== undefined) tool.args = data.args;
        if (event.type === 'tool_execution_update') {
          tool.progress =
            data.progress !== undefined
              ? record(data.progress)
              : { kind: 'custom', data: data.partialResult };
        } else if (event.type === 'tool_execution_end') {
          tool.result = data.result;
          tool.display = data.display ?? record(data.result).details;
          tool.status = data.isError ? 'failed' : 'succeeded';
          tool.endedAt = event.ts;
          if (!data.isError) {
            if (name === 'complete_stage') {
              const content = record(data.result).content;
              if (Array.isArray(content))
                for (const block of content) {
                  if (block?.type !== 'text') continue;
                  try {
                    if (JSON.parse(block.text).projectCompleted === true)
                      tool.projectCompleted = true;
                  } catch {
                    /* Ignore malformed display content. */
                  }
                }
            }
          }
        }
      }
      appendQuestion(event);
    }
  }
  if (!running) {
    settle(events.at(-1)?.ts ?? 0);
    if (assistant)
      assistant.status =
        terminalStatus === 'failed' || terminalStatus === 'cancelled'
          ? terminalStatus
          : 'succeeded';
  } else if (!assistant && (terminalStatus === 'queued' || !entries.length)) {
    // A queued retry may not have appended its start frame yet. Never animate its old reply.
    const last = events.at(-1);
    getAssistant({ id: (last?.id ?? 0) + 1, ts: (last?.ts ?? 0) + 1 });
  }
  const visible = deduplicateHandoffs(entries).filter(
    (e) =>
      e.boundary ||
      e.omitted ||
      e.parts.length ||
      // Empty failures belong in the run banner, not in fabricated replies.
      // Retain partial replies, active waiters and cancellation history.
      e.status === 'running' ||
      e.status === 'cancelled' ||
      e.status === 'interrupted',
  );
  if (events.some((event) => record(event.data).pblHistoryBefore) && visible.length)
    visible[0].omitted = true;
  return history ? visible : boundConversation(visible.slice(-60));
}

/** One model message, rather than the whole multi-call Agent turn. */
export function latestMessagePartIds(entries: LearningConversationEntry[]) {
  const modelEntry = entries.findLast((item) =>
    item.parts.some(
      (part) => (part.kind === 'text' || part.kind === 'thinking') && part.messageId !== undefined,
    ),
  );
  const entry =
    modelEntry ??
    entries.findLast((item) =>
      item.parts.some((part) => part.kind === 'text' || part.kind === 'thinking'),
    );
  const message = entry?.parts.findLast(
    (part) =>
      (part.kind === 'text' || part.kind === 'thinking') &&
      (!modelEntry || part.messageId !== undefined),
  );
  return new Set(
    entry?.parts
      .filter(
        (part) =>
          (part.kind === 'text' || part.kind === 'thinking') &&
          part.messageId === (message && 'messageId' in message ? message.messageId : undefined),
      )
      .map((part) => `${entry.id}:${part.id}`),
  );
}

/** Keep recent content whole, including nested tool data; omit older payloads at the shared byte boundary. */
export function boundConversation(
  entries: LearningConversationEntry[],
  budget = CONVERSATION_BYTES,
  currentPartIds = latestMessagePartIds(entries),
) {
  let remaining = budget;
  for (const entry of entries.toReversed()) {
    const kept: Part[] = [];
    for (const part of entry.parts.toReversed()) {
      const size = Buffer.byteLength(JSON.stringify(part));
      if (
        currentPartIds.has(`${entry.id}:${part.id}`) &&
        (part.kind === 'text' || part.kind === 'thinking')
      ) {
        kept.push(part);
      } else if (size <= remaining) {
        kept.push(part);
        remaining -= size;
      } else {
        entry.omitted = true;
        if (part.kind === 'tool') {
          const summary = { ...part };
          delete summary.args;
          delete summary.result;
          delete summary.display;
          delete summary.progress;
          summary.omitted = true;
          const bytes = Buffer.byteLength(JSON.stringify(summary));
          if (bytes <= remaining) {
            kept.push(summary);
            remaining -= bytes;
          }
        }
      }
    }
    entry.parts = kept.reverse();
  }
  return entries;
}
