import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { AgentSessionLeaseLostError } from '@openmaic/storage';
import { describe, expect, it, vi } from 'vitest';

import {
  appendInterruptedToolCallResults,
  orphanedToolCalls,
  repairOrphanedToolCalls,
  trackToolCallMessage,
  withToolCallIntegrityRepair,
  type PendingToolCall,
} from '@/lib/server/agent-runtime/tool-call-integrity';

const user = (text: string, timestamp: number): AgentMessage => ({
  role: 'user',
  content: text,
  timestamp,
});

const assistantText = (text: string, timestamp: number) =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp,
  }) as unknown as AgentMessage;

const assistantCalls = (calls: { id: string; name?: string }[], timestamp: number): AgentMessage =>
  ({
    role: 'assistant',
    content: calls.map((call) => ({
      type: 'toolCall',
      id: call.id,
      name: call.name ?? 'generate_scene',
      arguments: { sceneId: call.id },
    })),
    stopReason: 'toolUse',
    timestamp,
  }) as unknown as AgentMessage;

const toolResult = (id: string, timestamp: number): AgentMessage => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'generate_scene',
  content: [{ type: 'text', text: `result:${id}` }],
  details: { id },
  isError: false,
  timestamp,
});

function expectIntegrity(messages: AgentMessage[]): void {
  expect(orphanedToolCalls(messages)).toEqual([]);
}

function expectOriginalSubsequence(original: AgentMessage[], repaired: AgentMessage[]): void {
  let cursor = 0;
  for (const message of repaired) {
    if (message === original[cursor]) cursor += 1;
  }
  expect(cursor).toBe(original.length);
}

describe('read-time tool-call integrity repair', () => {
  it.each([
    ['a trailing orphan', () => [user('start', 1), assistantCalls([{ id: 'tail' }], 2)], ['tail']],
    [
      'a middle-of-history orphan',
      () => [user('start', 1), assistantCalls([{ id: 'middle' }], 2), assistantText('more', 3)],
      ['middle'],
    ],
    [
      'multiple consecutive orphans',
      () => [
        user('start', 1),
        assistantCalls([{ id: 'first' }], 2),
        assistantCalls([{ id: 'second' }], 3),
        assistantCalls([{ id: 'third' }], 4),
      ],
      ['first', 'second', 'third'],
    ],
    [
      'an orphan followed by a new user message',
      () => [
        user('first message', 1),
        assistantCalls([{ id: 'before-user' }], 2),
        user('a new user message must be preserved', 3),
      ],
      ['before-user'],
    ],
  ] as const)(
    'repairs %s without reordering or rewriting the original messages',
    (_name, build, ids) => {
      const original = build();
      const bytesBefore = original.map((message) => JSON.stringify(message));
      const repaired = repairOrphanedToolCalls(original, () => 99);

      expect(repaired.repairedToolCalls).toEqual(ids);
      expectIntegrity(repaired.messages);
      expectOriginalSubsequence(original, repaired.messages);
      expect(original.map((message) => JSON.stringify(message))).toEqual(bytesBefore);
    },
  );

  it('repairs partial parallel results by call id within one assistant frame', () => {
    const assistant = assistantCalls([{ id: 'done' }, { id: 'missing-a' }, { id: 'missing-b' }], 2);
    const done = toolResult('done', 3);
    const nextUser = user('continue', 4);
    const original = [user('start', 1), assistant, done, nextUser];

    const repaired = repairOrphanedToolCalls(original, () => 99);

    expect(repaired.repairedToolCalls).toEqual(['missing-a', 'missing-b']);
    expect(repaired.messages.slice(1, 5).map((message) => message.role)).toEqual([
      'assistant',
      'toolResult',
      'toolResult',
      'toolResult',
    ]);
    expect(repaired.messages[2]).toBe(done);
    expect(repaired.messages[5]).toBe(nextUser);
    expectIntegrity(repaired.messages);
  });

  it('moves a late parallel result back before the aborted assistant frame', () => {
    const calls = assistantCalls(
      [
        { id: 'fast', name: 'generate_actions' },
        { id: 'slow', name: 'generate_scene' },
      ],
      2,
    );
    const fast = toolResult('fast', 3);
    const aborted = {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      stopReason: 'aborted',
      errorMessage: 'worker aborted before flush',
      timestamp: 4,
    } as unknown as AgentMessage;
    const slow = toolResult('slow', 5);
    const original = [user('start', 1), calls, fast, aborted, slow];

    const repaired = repairOrphanedToolCalls(original, () => 99);

    expect(repaired.repairedToolCalls).toEqual([]);
    expect(repaired.messages).toEqual([user('start', 1), calls, fast, slow]);
    expect(repaired.messages[2]).toBe(fast);
    expect(repaired.messages[3]).toBe(slow);
    expectIntegrity(repaired.messages);
  });

  it('synthesizes receipts only for genuinely missing calls when late results coexist', () => {
    const calls = assistantCalls([{ id: 'done' }, { id: 'late' }, { id: 'missing' }], 2);
    const done = toolResult('done', 3);
    const barrier = {
      role: 'assistant',
      content: [{ type: 'text', text: 'interrupted tail' }],
      stopReason: 'aborted',
      errorMessage: 'worker stopped',
      timestamp: 4,
    } as unknown as AgentMessage;
    const late = toolResult('late', 5);

    const repaired = repairOrphanedToolCalls(
      [user('start', 1), calls, done, barrier, late],
      () => 99,
    );

    expect(repaired.repairedToolCalls).toEqual(['missing']);
    expect(repaired.messages.slice(1).map((message) => message.role)).toEqual([
      'assistant',
      'toolResult',
      'toolResult',
      'toolResult',
    ]);
    expect(repaired.messages[2]).toBe(done);
    expect(repaired.messages[3]).toBe(late);
    expect(repaired.messages[4]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'missing',
      isError: true,
    });
    expectIntegrity(repaired.messages);
  });

  it('returns a healthy transcript by reference, byte-identical', () => {
    const history = [
      user('start', 1),
      assistantCalls([{ id: 'done' }], 2),
      toolResult('done', 3),
      assistantText('done', 4),
    ];
    const bytesBefore = JSON.stringify(history);

    const repaired = repairOrphanedToolCalls(history);

    expect(repaired.messages).toBe(history);
    expect(JSON.stringify(repaired.messages)).toBe(bytesBefore);
    expect(repaired.repairedToolCalls).toEqual([]);
  });
});

describe('model-boundary repair after a re-materializing transform', () => {
  it('keeps a synthetic result when a transform re-materializes a missing receipt', async () => {
    const call = assistantCalls([{ id: 'call_00_orphan' }], 2);
    const raw = [user('import slide deck', 1), call];
    // Simulate a context transform that rebuilds the raw durable tree: it
    // replaces the repaired view with the raw orphan, exactly what a durable
    // context rebuild would do.
    const transform = async () => raw;
    const initialState = repairOrphanedToolCalls(raw, () => 99).messages;

    const transformed = await withToolCallIntegrityRepair(transform)(initialState);

    expect(transformed).toHaveLength(3);
    expect(transformed[1]).toBe(call);
    expect(transformed[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call_00_orphan',
      isError: true,
    });
    expectIntegrity(transformed);
  });

  it('reorders a late parallel result when a transform restores the raw durable order', async () => {
    const calls = assistantCalls([{ id: 'fast' }, { id: 'late' }], 2);
    const fast = toolResult('fast', 3);
    const aborted = {
      role: 'assistant',
      content: [],
      stopReason: 'aborted',
      timestamp: 4,
    } as unknown as AgentMessage;
    const late = toolResult('late', 5);
    const raw = [user('generate course', 1), calls, fast, aborted, late];
    const transform = async () => raw;
    const initialState = repairOrphanedToolCalls(raw, () => 99).messages;

    const transformed = await withToolCallIntegrityRepair(transform)(initialState);

    expect(transformed).toEqual([user('generate course', 1), calls, fast, late]);
  });
});

describe('write-time interrupted tool-call settlement', () => {
  it('abort settlement writes an interrupted result for every in-flight call', async () => {
    const inFlight = new Map<string, PendingToolCall>();
    trackToolCallMessage(
      inFlight,
      assistantCalls([{ id: 'done' }, { id: 'aborted-a' }, { id: 'aborted-b' }], 1),
    );
    trackToolCallMessage(inFlight, toolResult('done', 2));
    const appended: AgentMessage[] = [];

    await appendInterruptedToolCallResults([...inFlight.values()], {
      append: async (message) => {
        appended.push(message);
      },
      onFenceLost: vi.fn(),
      now: () => 3,
    });

    expect(appended).toMatchObject([
      { role: 'toolResult', toolCallId: 'aborted-a', isError: true },
      { role: 'toolResult', toolCallId: 'aborted-b', isError: true },
    ]);
    expect(appended.every((message) => JSON.stringify(message).includes('interrupted'))).toBe(true);
  });

  it('does not write results for a zombie run whose attempt fence was lost', async () => {
    const durableWrites: AgentMessage[] = [];
    const onFenceLost = vi.fn();
    const append = vi.fn(async (message: AgentMessage) => {
      const currentAttempt: number = Number('2');
      const zombieAttempt = 1;
      if (currentAttempt !== zombieAttempt) {
        throw new AgentSessionLeaseLostError('session-1', 'old-worker', zombieAttempt);
      }
      durableWrites.push(message);
    });

    await appendInterruptedToolCallResults([{ id: 'zombie', name: 'generate_scene' }], {
      append,
      onFenceLost,
      now: () => 3,
    });

    expect(append).toHaveBeenCalledOnce();
    expect(durableWrites).toEqual([]);
    expect(onFenceLost).toHaveBeenCalledOnce();
  });

  it('treats a wrapped fence loss (storage error carrying the lease error) as lost', async () => {
    const onFenceLost = vi.fn();
    const cause = new AgentSessionLeaseLostError('session-1', 'old-worker', 1);
    const wrapped = new Error('entry append rejected', { cause });
    const append = vi.fn(async () => {
      throw wrapped;
    });

    await appendInterruptedToolCallResults([{ id: 'wrapped', name: 'generate_scene' }], {
      append,
      onFenceLost,
      now: () => 3,
    });

    expect(onFenceLost).toHaveBeenCalledOnce();
  });
});
