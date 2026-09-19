import { describe, expect, it } from 'vitest';
import type { RuntimeSessionStatus } from '@openmaic/dsl';
import type { UIMessage } from 'ai';

import type { ChatMessageMetadata, ChatSession } from '@/lib/types/chat';
import {
  buildChatRecordInit,
  fromLegacyRecords,
  normalizeSession,
  planChatSync,
} from '@/lib/utils/chat-storage-core';

const STAGE_ID = 'stage-core';
const LEARNER_KEY = 'anon:core';
const BASE_RUNTIME_ID = 'chat:stage-core:anon%3Acore:session-core';

function message(): UIMessage<ChatMessageMetadata> {
  return {
    id: 'message-1',
    role: 'user',
    parts: [{ type: 'text', text: 'Hello' }],
    metadata: { createdAt: 1_000, originalRole: 'user' },
  };
}

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-core',
    type: 'qa',
    title: 'Q&A',
    status: 'interrupted',
    messages: [message()],
    config: { agentIds: ['default-1'], defaultAgentId: 'default-1' },
    toolCalls: [],
    pendingToolCalls: [],
    createdAt: 900,
    updatedAt: 1_200,
    ...overrides,
  };
}

function messagePayload(chat: ChatSession) {
  return {
    kind: 'chat_message' as const,
    payloadVersion: 1 as const,
    role: 'user' as const,
    content: 'Hello',
    message: chat.messages[0]!,
    sessionUpdatedAt: chat.updatedAt,
  };
}

function statePayload(chat: ChatSession) {
  return {
    kind: 'chat_session_state' as const,
    payloadVersion: 1 as const,
    role: 'system' as const,
    content: chat.title,
    chatSessionId: chat.id,
    type: chat.type,
    title: chat.title,
    status: chat.status,
    config: chat.config,
    toolCalls: chat.toolCalls,
    messageIds: chat.messages.map((item) => item.id),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}

type ChatSyncViews = Parameters<typeof planChatSync>[1];

function view(
  chat: ChatSession,
  options: {
    id?: string;
    status?: RuntimeSessionStatus;
    records?: number;
    state?: ReturnType<typeof statePayload>;
  } = {},
): ChatSyncViews[number] {
  const id = options.id ?? BASE_RUNTIME_ID;
  const payload = messagePayload(chat);
  return {
    runtimeSession: {
      id,
      kind: 'chat',
      stageId: STAGE_ID,
      learnerKey: LEARNER_KEY,
      status: options.status ?? 'active',
      createdAt: new Date(chat.createdAt).toISOString(),
      updatedAt: new Date(chat.updatedAt).toISOString(),
      runtimeDslVersion: '0.1.0',
    },
    records: Array.from(
      { length: options.records ?? 0 },
      () => ({}),
    ) as ChatSyncViews[number]['records'],
    folded: {
      session: options.state ? chat : undefined,
      messages: new Map([[chat.messages[0]!.id, payload]]),
      state: options.state,
    },
  };
}

function desired(chat: ChatSession, isolatedWrites = false) {
  return { session: chat, stageId: STAGE_ID, learnerKey: LEARNER_KEY, isolatedWrites };
}

describe('buildChatRecordInit', () => {
  it('constructs stable ids and omits malformed optional anchors', () => {
    const chat = {
      ...session(),
      sceneId: null,
      lastActionIndex: null,
    } as unknown as ChatSession;
    const payload = messagePayload(chat);

    expect(buildChatRecordInit(BASE_RUNTIME_ID, payload, chat, 'message:message-1')).toEqual({
      id: `${BASE_RUNTIME_ID}:message:message-1:1200`,
      sessionId: BASE_RUNTIME_ID,
      createdAt: '1970-01-01T00:00:01.200Z',
      payload,
    });
  });

  it('keeps valid scene and action anchors', () => {
    const chat = session({ sceneId: 'scene-1', lastActionIndex: 3 });
    const record = buildChatRecordInit(BASE_RUNTIME_ID, messagePayload(chat), chat, 'state');

    expect(record).toMatchObject({ sceneId: 'scene-1', actionIndex: 3 });
  });
});

describe('planChatSync', () => {
  it('plans deterministic session creation before any append IO', () => {
    expect(planChatSync(desired(session()), [])).toEqual({
      kind: 'create-session',
      baseRuntimeId: BASE_RUNTIME_ID,
      generation: 0,
      init: {
        id: BASE_RUNTIME_ID,
        kind: 'chat',
        stageId: STAGE_ID,
        learnerKey: LEARNER_KEY,
        status: 'active',
        createdAt: '1970-01-01T00:00:00.900Z',
        updatedAt: '1970-01-01T00:00:01.200Z',
      },
    });
  });

  it('plans reactivation, appends, and the final completed status in order', () => {
    const chat = session({ status: 'completed', title: 'Updated' });
    const previous = session({ status: 'completed' });
    const plan = planChatSync(desired(chat), [
      view(chat, { status: 'archived', state: statePayload(previous) }),
    ]);

    expect(plan).toMatchObject({
      kind: 'write',
      preStatus: 'active',
      finalStatus: 'completed',
      appends: [{ suffix: 'state' }],
    });
  });

  it('plans a generation rollover for a completed destination with changes', () => {
    const chat = session({ title: 'Updated' });
    const previous = session();
    const plan = planChatSync(desired(chat), [
      view(chat, { status: 'completed', state: statePayload(previous) }),
    ]);

    expect(plan).toMatchObject({
      kind: 'start-generation',
      init: { id: `${BASE_RUNTIME_ID}:generation:1`, status: 'active' },
    });
  });

  it('plans record-limit rollover without performing IO', () => {
    const chat = session();
    const plan = planChatSync(desired(chat), [
      view(chat, { records: 257, state: statePayload(chat) }),
    ]);

    expect(plan).toMatchObject({ kind: 'complete-and-refresh' });
  });

  it('plans isolated reuse and retirement for an unchanged snapshot', () => {
    const chat = session();
    const newer = view(chat, {
      id: `${BASE_RUNTIME_ID}:generation:2:newer`,
      state: statePayload(chat),
    });
    const older = view(chat, {
      id: `${BASE_RUNTIME_ID}:generation:1:older`,
      status: 'completed',
      state: statePayload(chat),
    });
    const plan = planChatSync(desired(chat, true), [older, newer]);

    expect(plan).toMatchObject({
      kind: 'reuse-isolated',
      destination: { runtimeSession: { id: `${BASE_RUNTIME_ID}:generation:2:newer` } },
      retired: [{ runtimeSession: { id: `${BASE_RUNTIME_ID}:generation:1:older` } }],
    });
  });
});

describe('fromLegacyRecords', () => {
  it('passes through finite ISO-valid future timestamps deterministically', () => {
    const future = {
      ...session(),
      createdAt: Number.NaN,
      updatedAt: Date.UTC(2056, 0, 1),
    };

    const first = fromLegacyRecords([future]);
    const second = fromLegacyRecords([future]);

    expect(first).toEqual(second);
    expect(first.sessions[0]).toMatchObject({
      createdAt: Date.UTC(2056, 0, 1),
      updatedAt: Date.UTC(2056, 0, 1),
    });
  });

  it('repairs only out-of-range timestamps and enforces timestamp order', () => {
    expect(
      fromLegacyRecords([
        { ...session(), createdAt: Number.NaN, updatedAt: 1_200 },
        { ...session({ id: 'second' }), createdAt: 900, updatedAt: Number.NaN },
        { ...session({ id: 'third' }), createdAt: -1, updatedAt: 1_500 },
        {
          ...session({ id: 'fourth' }),
          createdAt: 2_000,
          updatedAt: 253_402_300_800_000,
        },
        {
          ...session({ id: 'fifth' }),
          createdAt: Number.NaN,
          updatedAt: Number.POSITIVE_INFINITY,
        },
      ]),
    ).toMatchObject({
      sessions: [
        { createdAt: 1_200, updatedAt: 1_200 },
        { createdAt: 900, updatedAt: 900 },
        { createdAt: 1_500, updatedAt: 1_500 },
        { createdAt: 2_000, updatedAt: 2_000 },
        { createdAt: Date.UTC(2026, 7, 1), updatedAt: Date.UTC(2026, 7, 1) },
      ],
      skippedRows: [],
    });
  });

  it('reports malformed payloads and rows to the migration caller', () => {
    expect(fromLegacyRecords({ rows: [] })).toEqual({
      sessions: [],
      skippedRows: [{ index: -1, reason: 'expected an array payload' }],
    });
    expect(
      fromLegacyRecords([
        { ...session(), messages: null },
        { ...session({ id: 'valid' }), toolCalls: [] },
      ]),
    ).toMatchObject({
      sessions: [{ id: 'valid' }],
      skippedRows: [{ index: 0, id: 'session-core' }],
    });
  });
});

describe('normalizeSession', () => {
  it.each(['active', 'soft-closing'] as const)(
    'normalizes an inactive %s session to interrupted',
    (status) => {
      expect(normalizeSession(session({ status })).status).toBe('interrupted');
    },
  );
  it('preserves terminal statuses', () => {
    expect(normalizeSession(session({ status: 'completed' })).status).toBe('completed');
  });
});
