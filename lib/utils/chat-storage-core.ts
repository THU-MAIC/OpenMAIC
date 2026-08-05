/** Pure chat persistence transformations shared by browser and Node consumers. */

import type {
  ChatMessageSkeleton,
  RuntimeRecord,
  RuntimeRecordInit,
  RuntimeSession,
} from '@openmaic/dsl';
import type { RuntimeSessionInit } from '@openmaic/storage';
import type { UIMessage } from 'ai';
import { isEqual } from 'lodash';

import type { ChatMessageMetadata, ChatSession, SessionStatus } from '@/lib/types/chat';
import type { ChatSessionRecord } from './database';

const MAX_MESSAGES_PER_SESSION = 200;
const MAX_RUNTIME_RECORDS_PER_CHAT_SESSION = 256;
const CHAT_PAYLOAD_VERSION = 1;
const RUNTIME_GENERATION_SEPARATOR = ':generation:';
const MAX_FOUR_DIGIT_ISO_TIMESTAMP = 253_402_300_799_999;
const LEGACY_TIMESTAMP_REPAIR_ANCHOR = Date.UTC(2026, 7, 1);

export interface ChatMessagePayload extends ChatMessageSkeleton {
  kind: 'chat_message';
  payloadVersion: typeof CHAT_PAYLOAD_VERSION;
  message: UIMessage<ChatMessageMetadata>;
  sessionUpdatedAt: number;
}

export interface ChatSessionStatePayload extends ChatMessageSkeleton {
  kind: 'chat_session_state';
  payloadVersion: typeof CHAT_PAYLOAD_VERSION;
  chatSessionId: string;
  type: ChatSession['type'];
  title: string;
  status: SessionStatus;
  config: ChatSession['config'];
  toolCalls: ChatSession['toolCalls'];
  messageIds: string[];
  createdAt: number;
  updatedAt: number;
  sceneId?: string;
  lastActionIndex?: number;
}

export interface FoldedChat {
  session?: ChatSession;
  messages: Map<string, ChatMessagePayload>;
  state?: ChatSessionStatePayload;
}

export interface ChatRuntimeView {
  runtimeSession: RuntimeSession;
  records: RuntimeRecord[];
  folded: FoldedChat;
}

export interface ChatRuntimeCandidate extends ChatRuntimeView {
  baseRuntimeId: string;
  generation: number;
}

export interface ChatSessionChanges {
  nextState: ChatSessionStatePayload;
  changedMessages: UIMessage<ChatMessageMetadata>[];
  stateChanged: boolean;
}

export interface SkippedLegacyChatRow {
  index: number;
  id?: string;
  reason: string;
}

export interface LegacyChatConversion {
  sessions: ChatSession[];
  skippedRows: SkippedLegacyChatRow[];
}

export interface ChatAppendPlan {
  payload: ChatMessagePayload | ChatSessionStatePayload;
  suffix: string;
}

export interface ChatSyncDesired {
  session: ChatSession;
  stageId: string;
  learnerKey: string;
  isolatedWrites: boolean;
}

export type ChatSyncPlan =
  | {
      kind: 'create-session';
      baseRuntimeId: string;
      generation: number;
      init: RuntimeSessionInit;
    }
  | {
      kind: 'reuse-isolated';
      destination: ChatRuntimeCandidate;
      completeDestination: boolean;
      retired: ChatRuntimeCandidate[];
    }
  | {
      kind: 'replace-isolated';
      baseRuntimeId: string;
      generation: number;
      candidates: ChatRuntimeCandidate[];
      appends: ChatAppendPlan[];
      finalStatus?: 'completed';
    }
  | {
      kind: 'complete-and-refresh';
      destination: ChatRuntimeCandidate;
    }
  | {
      kind: 'start-generation';
      init: RuntimeSessionInit;
    }
  | {
      kind: 'write';
      destination: ChatRuntimeCandidate;
      appends: ChatAppendPlan[];
      preStatus?: 'active';
      finalStatus?: 'active' | 'completed';
    };

function isLegacyRecord(record: unknown): record is ChatSessionRecord {
  if (typeof record !== 'object' || record === null) return false;
  const candidate = record as Partial<ChatSessionRecord>;
  return (
    typeof candidate.id === 'string' &&
    (candidate.type === 'qa' || candidate.type === 'discussion' || candidate.type === 'lecture') &&
    typeof candidate.title === 'string' &&
    (candidate.status === 'idle' ||
      candidate.status === 'active' ||
      candidate.status === 'soft-closing' ||
      candidate.status === 'interrupted' ||
      candidate.status === 'completed' ||
      candidate.status === 'error') &&
    Array.isArray(candidate.messages) &&
    candidate.messages.every(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        typeof (message as { id?: unknown }).id === 'string' &&
        Array.isArray((message as { parts?: unknown }).parts) &&
        (message as { parts: unknown[] }).parts.every(
          (part) => typeof part === 'object' && part !== null,
        ),
    ) &&
    typeof candidate.config === 'object' &&
    candidate.config !== null &&
    Array.isArray(candidate.toolCalls) &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.updatedAt === 'number'
  );
}

function legacyTimestamps(record: ChatSessionRecord): { createdAt: number; updatedAt: number } {
  const validRange = (timestamp: number): boolean =>
    Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= MAX_FOUR_DIGIT_ISO_TIMESTAMP;
  const createdAt = validRange(record.createdAt)
    ? record.createdAt
    : validRange(record.updatedAt)
      ? record.updatedAt
      : LEGACY_TIMESTAMP_REPAIR_ANCHOR;
  const updatedAt = validRange(record.updatedAt)
    ? record.updatedAt
    : validRange(record.createdAt)
      ? record.createdAt
      : LEGACY_TIMESTAMP_REPAIR_ANCHOR;

  // Within-range timestamps are preserved, including valid future values.
  // Only raise updatedAt to createdAt when their order is reversed. Preserving
  // the newer value avoids repeatedly rewriting history and follows the
  // ordinary rule that the newer legacy row wins.
  return { createdAt, updatedAt: Math.max(createdAt, updatedAt) };
}

export function fromLegacyRecord(record: ChatSessionRecord): ChatSession {
  if (!isLegacyRecord(record)) throw new TypeError('invalid legacy chat row shape');
  const { createdAt, updatedAt } = legacyTimestamps(record);
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    status: record.status,
    messages: record.messages as UIMessage<ChatMessageMetadata>[],
    config: record.config,
    toolCalls: record.toolCalls,
    pendingToolCalls: Array.isArray(record.pendingToolCalls) ? record.pendingToolCalls : [],
    createdAt,
    updatedAt,
    ...(typeof record.sceneId === 'string' ? { sceneId: record.sceneId } : {}),
    ...(Number.isInteger(record.lastActionIndex)
      ? { lastActionIndex: record.lastActionIndex }
      : {}),
  };
}

export function fromLegacyRecords(records: unknown): LegacyChatConversion {
  if (!Array.isArray(records)) {
    return {
      sessions: [],
      skippedRows: [{ index: -1, reason: 'expected an array payload' }],
    };
  }
  const sessions: ChatSession[] = [];
  const skippedRows: SkippedLegacyChatRow[] = [];
  records.forEach((record, index) => {
    try {
      sessions.push(normalizeSession(fromLegacyRecord(record as ChatSessionRecord)));
    } catch (error) {
      const id =
        typeof record === 'object' &&
        record !== null &&
        typeof (record as { id?: unknown }).id === 'string'
          ? (record as { id: string }).id
          : undefined;
      skippedRows.push({
        index,
        ...(id === undefined ? {} : { id }),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { sessions, skippedRows };
}

export function normalizeSession(session: ChatSession): ChatSession {
  return {
    ...session,
    status:
      session.status === 'active' || session.status === 'soft-closing'
        ? 'interrupted'
        : session.status,
    messages: session.messages.slice(-MAX_MESSAGES_PER_SESSION),
    pendingToolCalls: [],
  };
}

export function runtimeSessionId(
  stageId: string,
  learnerKey: string,
  chatSessionId: string,
): string {
  return `chat:${encodeURIComponent(stageId)}:${encodeURIComponent(learnerKey)}:${encodeURIComponent(chatSessionId)}`;
}

export function generationRuntimeSessionId(
  baseRuntimeId: string,
  generation: number,
  writerToken?: string,
): string {
  return `${baseRuntimeId}${RUNTIME_GENERATION_SEPARATOR}${generation}${writerToken ? `:${writerToken}` : ''}`;
}

export function chatRuntimeIdentity(
  runtimeId: string,
  stageId: string,
  chatSessionId: string,
): { baseRuntimeId: string; generation: number } | undefined {
  const markerIndex = runtimeId.lastIndexOf(RUNTIME_GENERATION_SEPARATOR);
  let baseRuntimeId = runtimeId;
  let generation = 0;
  if (markerIndex >= 0) {
    baseRuntimeId = runtimeId.slice(0, markerIndex);
    const rawIdentity = runtimeId.slice(markerIndex + RUNTIME_GENERATION_SEPARATOR.length);
    const [rawGeneration, writerToken, ...extra] = rawIdentity.split(':');
    if (!/^[1-9]\d*$/.test(rawGeneration)) return undefined;
    if (extra.length > 0 || (writerToken !== undefined && !/^[\w-]+$/.test(writerToken))) {
      return undefined;
    }
    generation = Number(rawGeneration);
    if (!Number.isSafeInteger(generation)) return undefined;
  }
  if (
    !baseRuntimeId.startsWith(`chat:${encodeURIComponent(stageId)}:`) ||
    !baseRuntimeId.endsWith(`:${encodeURIComponent(chatSessionId)}`)
  ) {
    return undefined;
  }
  return { baseRuntimeId, generation };
}

export function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function messageContent(message: UIMessage<ChatMessageMetadata>): string {
  return message.parts
    .filter(
      (part): part is Extract<(typeof message.parts)[number], { type: 'text' }> =>
        part.type === 'text',
    )
    .map((part) => part.text)
    .join('');
}

function messagePayload(
  message: UIMessage<ChatMessageMetadata>,
  sessionUpdatedAt: number,
): ChatMessagePayload {
  return {
    kind: 'chat_message',
    payloadVersion: CHAT_PAYLOAD_VERSION,
    role: message.role,
    content: messageContent(message),
    message,
    sessionUpdatedAt,
  };
}

export function statePayload(session: ChatSession): ChatSessionStatePayload {
  return {
    kind: 'chat_session_state',
    payloadVersion: CHAT_PAYLOAD_VERSION,
    role: 'system',
    content: session.title,
    chatSessionId: session.id,
    type: session.type,
    title: session.title,
    status: session.status,
    config: session.config,
    toolCalls: session.toolCalls,
    messageIds: session.messages.map((message) => message.id),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(typeof session.sceneId === 'string' ? { sceneId: session.sceneId } : {}),
    ...(Number.isInteger(session.lastActionIndex)
      ? { lastActionIndex: session.lastActionIndex }
      : {}),
  };
}

function isMessagePayload(payload: unknown): payload is ChatMessagePayload {
  const candidate = payload as Partial<ChatMessagePayload> | null;
  return (
    candidate?.kind === 'chat_message' &&
    candidate.payloadVersion === CHAT_PAYLOAD_VERSION &&
    typeof candidate.message?.id === 'string' &&
    (candidate.message.role === 'user' ||
      candidate.message.role === 'assistant' ||
      candidate.message.role === 'system') &&
    Array.isArray(candidate.message.parts) &&
    typeof candidate.sessionUpdatedAt === 'number' &&
    Number.isFinite(candidate.sessionUpdatedAt)
  );
}

function isStatePayload(payload: unknown): payload is ChatSessionStatePayload {
  const candidate = payload as Partial<ChatSessionStatePayload> | null;
  return (
    candidate?.kind === 'chat_session_state' &&
    candidate.payloadVersion === CHAT_PAYLOAD_VERSION &&
    typeof candidate.chatSessionId === 'string' &&
    (candidate.type === 'qa' || candidate.type === 'discussion' || candidate.type === 'lecture') &&
    typeof candidate.title === 'string' &&
    (candidate.status === 'idle' ||
      candidate.status === 'active' ||
      candidate.status === 'soft-closing' ||
      candidate.status === 'interrupted' ||
      candidate.status === 'completed' ||
      candidate.status === 'error') &&
    typeof candidate.config === 'object' &&
    candidate.config !== null &&
    Array.isArray(candidate.toolCalls) &&
    Array.isArray(candidate.messageIds) &&
    candidate.messageIds.every((id) => typeof id === 'string') &&
    typeof candidate.createdAt === 'number' &&
    Number.isFinite(candidate.createdAt) &&
    typeof candidate.updatedAt === 'number' &&
    Number.isFinite(candidate.updatedAt) &&
    (candidate.sceneId === undefined || typeof candidate.sceneId === 'string') &&
    (candidate.lastActionIndex === undefined || Number.isInteger(candidate.lastActionIndex))
  );
}

export function foldRecords(records: RuntimeRecord[]): FoldedChat {
  const messages = new Map<string, ChatMessagePayload>();
  const messageSeqs = new Map<string, number>();
  let state: ChatSessionStatePayload | undefined;
  let stateSeq = -1;
  for (const record of records) {
    if (isMessagePayload(record.payload)) {
      const id = record.payload.message.id;
      const current = messages.get(id);
      if (
        !current ||
        record.payload.sessionUpdatedAt > current.sessionUpdatedAt ||
        (record.payload.sessionUpdatedAt === current.sessionUpdatedAt &&
          record.seq > (messageSeqs.get(id) ?? -1))
      ) {
        messages.set(id, record.payload);
        messageSeqs.set(id, record.seq);
      }
    }
    if (
      isStatePayload(record.payload) &&
      (!state ||
        record.payload.updatedAt > state.updatedAt ||
        (record.payload.updatedAt === state.updatedAt && record.seq > stateSeq))
    ) {
      state = record.payload;
      stateSeq = record.seq;
    }
  }
  if (!state) return { messages };
  return {
    messages,
    state,
    session: {
      id: state.chatSessionId,
      type: state.type,
      title: state.title,
      status: state.status,
      messages: state.messageIds.flatMap((id) => {
        const payload = messages.get(id);
        return payload ? [payload.message] : [];
      }),
      config: state.config,
      toolCalls: state.toolCalls,
      pendingToolCalls: [],
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      sceneId: state.sceneId,
      lastActionIndex: state.lastActionIndex,
    },
  };
}

export function changesForSession(normalized: ChatSession, folded: FoldedChat): ChatSessionChanges {
  const nextState = statePayload(normalized);
  return {
    nextState,
    changedMessages: normalized.messages.filter((message) => {
      const current = folded.messages.get(message.id);
      return !current || !isEqual(current.message, message);
    }),
    stateChanged: !folded.state || !isEqual(folded.state, nextState),
  };
}

export function chatRuntimeCandidates(
  views: ChatRuntimeView[],
  stageId: string,
  chatSessionId: string,
): ChatRuntimeCandidate[] {
  return views.flatMap((view) => {
    const identity = chatRuntimeIdentity(view.runtimeSession.id, stageId, chatSessionId);
    return identity ? [{ ...view, ...identity }] : [];
  });
}

export function newestRuntimeCandidate(
  candidates: ChatRuntimeCandidate[],
): ChatRuntimeCandidate | undefined {
  return [...candidates].sort((left, right) => {
    const leftUpdatedAt = left.folded.state?.updatedAt ?? Number.NEGATIVE_INFINITY;
    const rightUpdatedAt = right.folded.state?.updatedAt ?? Number.NEGATIVE_INFINITY;
    if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
    if (left.generation !== right.generation) return right.generation - left.generation;
    return right.runtimeSession.id.localeCompare(left.runtimeSession.id);
  })[0];
}

function highestGeneration(
  candidates: ChatRuntimeCandidate[],
  baseRuntimeId: string,
): ChatRuntimeCandidate | undefined {
  return candidates
    .filter((candidate) => candidate.baseRuntimeId === baseRuntimeId)
    .sort((left, right) => {
      if (left.generation !== right.generation) return right.generation - left.generation;
      const leftUpdatedAt = left.folded.state?.updatedAt ?? Number.NEGATIVE_INFINITY;
      const rightUpdatedAt = right.folded.state?.updatedAt ?? Number.NEGATIVE_INFINITY;
      if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
      return right.runtimeSession.id.localeCompare(left.runtimeSession.id);
    })[0];
}

export function buildChatRecordInit(
  runtimeId: string,
  payload: ChatMessagePayload | ChatSessionStatePayload,
  session: ChatSession,
  suffix: string,
): RuntimeRecordInit {
  const actionIndex = session.lastActionIndex;
  return {
    id: `${runtimeId}:${suffix}:${session.updatedAt}`,
    sessionId: runtimeId,
    createdAt: iso(session.updatedAt),
    ...(typeof session.sceneId === 'string' ? { sceneId: session.sceneId } : {}),
    ...(Number.isInteger(actionIndex) && actionIndex !== undefined && actionIndex >= 0
      ? { actionIndex }
      : {}),
    payload,
  };
}

/** Decide one synchronization step without reading or mutating storage. */
export function planChatSync(desired: ChatSyncDesired, views: ChatRuntimeView[]): ChatSyncPlan {
  const { session, stageId, learnerKey, isolatedWrites } = desired;
  const candidates = chatRuntimeCandidates(views, stageId, session.id);
  const source = newestRuntimeCandidate(candidates);
  const baseRuntimeId = source?.baseRuntimeId ?? runtimeSessionId(stageId, learnerKey, session.id);
  const destination = highestGeneration(candidates, baseRuntimeId);
  const sessionInit = (id: string): RuntimeSessionInit => ({
    id,
    kind: 'chat',
    stageId,
    learnerKey,
    status: 'active',
    createdAt: iso(session.createdAt),
    updatedAt: iso(session.updatedAt),
  });
  const appendPlans = (
    messages: UIMessage<ChatMessageMetadata>[],
    state?: ChatSessionStatePayload,
  ): ChatAppendPlan[] => [
    ...messages.map((message) => ({
      payload: messagePayload(message, session.updatedAt),
      suffix: `message:${encodeURIComponent(message.id)}`,
    })),
    ...(state ? [{ payload: state, suffix: 'state' }] : []),
  ];

  if (isolatedWrites) {
    const folded = destination?.folded ?? { messages: new Map<string, ChatMessagePayload>() };
    const changes = changesForSession(session, folded);
    const appendCount = changes.changedMessages.length + (changes.stateChanged ? 1 : 0);
    if (destination && appendCount === 0) {
      return {
        kind: 'reuse-isolated',
        destination,
        completeDestination:
          session.status === 'completed' && destination.runtimeSession.status !== 'completed',
        retired: candidates.filter(
          (candidate) => candidate.runtimeSession.id !== destination.runtimeSession.id,
        ),
      };
    }

    const generation = Math.max(0, ...candidates.map((candidate) => candidate.generation)) + 1;
    return {
      kind: 'replace-isolated',
      baseRuntimeId,
      generation,
      candidates,
      appends: appendPlans(session.messages, statePayload(session)),
      ...(session.status === 'completed' ? { finalStatus: 'completed' as const } : {}),
    };
  }

  if (!destination) {
    return {
      kind: 'create-session',
      baseRuntimeId,
      generation: 0,
      init: sessionInit(baseRuntimeId),
    };
  }

  const changes = changesForSession(session, destination.folded);
  const appendCount = changes.changedMessages.length + (changes.stateChanged ? 1 : 0);
  if (
    destination.folded.state &&
    changes.changedMessages.length > 0 &&
    destination.runtimeSession.status !== 'completed'
  ) {
    return { kind: 'complete-and-refresh', destination };
  }
  const needsRollover =
    destination.records.length > MAX_RUNTIME_RECORDS_PER_CHAT_SESSION ||
    (appendCount > 0 &&
      destination.records.length + appendCount > MAX_RUNTIME_RECORDS_PER_CHAT_SESSION);
  if (
    destination.runtimeSession.status === 'completed' &&
    (appendCount > 0 || destination.records.length > MAX_RUNTIME_RECORDS_PER_CHAT_SESSION)
  ) {
    return {
      kind: 'start-generation',
      init: sessionInit(generationRuntimeSessionId(baseRuntimeId, destination.generation + 1)),
    };
  }
  if (needsRollover) return { kind: 'complete-and-refresh', destination };

  const preStatus =
    appendCount > 0 && destination.runtimeSession.status !== 'active'
      ? ('active' as const)
      : undefined;
  const effectiveStatus = preStatus ?? destination.runtimeSession.status;
  const desiredStatus = session.status === 'completed' ? 'completed' : 'active';
  const finalStatus =
    effectiveStatus !== desiredStatus && !(effectiveStatus === 'completed' && appendCount === 0)
      ? desiredStatus
      : undefined;
  return {
    kind: 'write',
    destination,
    appends: appendPlans(
      changes.changedMessages,
      changes.stateChanged ? changes.nextState : undefined,
    ),
    ...(preStatus ? { preStatus } : {}),
    ...(finalStatus ? { finalStatus } : {}),
  };
}
