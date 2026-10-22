import 'server-only';
import type { PersistedAgentSessionEvent } from '@openmaic/storage';
import type { AgentRole } from '@/lib/pbl/v3/domain/project/project-schema';
import type { LearningConversationEntry, LearningRunFailure } from '@/lib/pbl/v3/conversation';
import { reviewQuestion } from './review-question';

/** Never send provider diagnostics, addresses or credentials to a learner. */
export function learningRunFailure(error: unknown): LearningRunFailure {
  const message = typeof error === 'string' ? error : '';
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
  'tool_execution_end',
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** Project files and operation results are visible; hashes, leases, protocol and raw errors are not. */
function displayArgs(name: string, value: unknown): Record<string, string> | undefined {
  const args = record(value),
    output: Record<string, string> = {};
  const fields =
    name === 'manage_file'
      ? ['action', 'path', 'destination', 'text']
      : name === 'read_file'
        ? ['path']
        : name === 'write_file'
          ? ['path', 'text']
          : name === 'request_skill_review'
            ? ['question']
            : [];
  for (const key of fields)
    if (typeof args[key] === 'string') output[key] = args[key].slice(0, 64000);
  return Object.keys(output).length ? output : undefined;
}
function displayResult(name: string, raw: unknown): string | undefined {
  const content = record(raw).content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    let value: Record<string, unknown>;
    try {
      value = record(JSON.parse(block.text));
    } catch {
      continue;
    }
    if (name === 'read_file' && typeof value.text === 'string') return value.text.slice(0, 64000);
    if (name === 'list_files' && Array.isArray(value.files))
      return value.files
        .filter((p): p is string => typeof p === 'string')
        .join('\n')
        .slice(0, 16000);
    // Structured receipts only. Do not publish test drivers, teaching sections or provider diagnostics.
    const fields =
      name === 'write_file'
        ? ['written', 'changed']
        : name === 'manage_file'
          ? ['action', 'path', 'destination', 'changed']
          : name === 'run_build' || name === 'collect_build'
            ? ['state', 'pending', 'passed', 'exitCode', 'output']
            : name === 'read_next_skill'
              ? ['section']
              : [];
    const result: Record<string, unknown> = {};
    for (const key of fields)
      if (['string', 'number', 'boolean'].includes(typeof value[key])) result[key] = value[key];
    if (Object.keys(result).length) return JSON.stringify(result, null, 2);
  }
}

/** Fold durable Pi snapshots in content order, sharing the host's presentation components. */
export function projectConversation(
  events: PersistedAgentSessionEvent[],
  role: AgentRole,
  running: boolean,
  terminalStatus?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'missing',
): LearningConversationEntry[] {
  const entries: LearningConversationEntry[] = [];
  let assistant: LearningConversationEntry | undefined;
  let attempt: number | undefined;
  const blocks = new Map<number, Extract<Part, { kind: 'text' | 'thinking' }>>();
  const tools = new Map<string, ToolPart>();
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
  };
  const getAssistant = (event: Pick<PersistedAgentSessionEvent, 'id' | 'ts'>) => {
    if (!assistant) {
      assistant = {
        id: `turn-${event.id}`,
        at: event.ts,
        speaker: role,
        status: 'running',
        parts: [],
      };
      entries.push(assistant);
    }
    return assistant;
  };
  for (const event of events) {
    const data = record(event.data);
    if (event.type === 'pbl_stage_entered') {
      settle(event.ts);
      assistant = undefined;
      attempt = undefined;
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
      settle(event.ts);
      if (assistant?.status === 'running') assistant.status = 'succeeded';
      assistant = undefined;
      attempt = undefined;
      if (!data.pblOpening && typeof data.text === 'string')
        entries.push({
          id: `user-${event.id}`,
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
      if (event.type === 'message_start') {
        settleThinking(event.ts);
        for (const part of blocks.values()) part.streaming = false;
        blocks.clear();
      }
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
              ? { kind: 'thinking', id: `thinking-${event.id}-${index}`, text, startedAt: event.ts }
              : { kind: 'text', id: `text-${event.id}-${index}`, text };
          blocks.set(index, part);
          getAssistant(event).parts.push(part);
        }
        part.text = text;
        part.streaming =
          event.type !== 'message_end' && (part.kind !== 'thinking' || part.endedAt === undefined);
      }
      if (event.type === 'message_end') {
        settleThinking(event.ts);
        for (const part of blocks.values()) part.streaming = false;
        blocks.clear();
      }
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      settleThinking(event.ts);
      const name = String(data.toolName ?? '');
      const action = visibleTools[name as keyof typeof visibleTools];
      if (action && typeof data.toolCallId === 'string') {
        let tool = tools.get(data.toolCallId);
        if (!tool) {
          tool = {
            kind: 'tool',
            id: `tool-${event.attempt}-${event.id}-${data.toolCallId}`,
            name,
            action,
            status: 'running',
            ...(event.type === 'tool_execution_start' ? { startedAt: event.ts } : {}),
          };
          tools.set(data.toolCallId, tool);
          getAssistant(event).parts.push(tool);
        }
        if (event.type === 'tool_execution_start') tool.args = displayArgs(name, data.args);
        else {
          tool.status = data.isError ? 'failed' : 'succeeded';
          tool.endedAt = event.ts;
          if (!data.isError) tool.result = displayResult(name, data.result);
        }
      }
      const question = reviewQuestion(event);
      if (question)
        getAssistant(event).parts.push({
          kind: 'text',
          id: `question-${event.id}`,
          text: question,
        });
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
  return entries
    .filter(
      (e) =>
        e.boundary ||
        e.parts.length ||
        e.status === 'running' ||
        e.status === 'failed' ||
        e.status === 'cancelled' ||
        e.status === 'interrupted',
    )
    .slice(-60);
}
