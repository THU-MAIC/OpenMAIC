import { InMemorySessionRepo, type AgentMessage } from '@earendil-works/pi-agent-core';
import { AgentSessionLeaseLostError } from '@openmaic/storage';
import { describe, expect, it, vi } from 'vitest';

import { acquireDurableCompactionSession } from '@/lib/server/agent-runtime/runner';
import { repairOrphanedToolCalls } from '@/lib/server/agent-runtime/tool-call-integrity';

const fence = {
  sessionId: 'session-1',
  workerId: 'worker-1',
  attempt: 2,
};

describe('runner durable compaction acquisition', () => {
  it('flushes before returning a complete durable entry tree', async () => {
    const session = await new InMemorySessionRepo().create({ id: fence.sessionId });
    const messages: AgentMessage[] = [
      { role: 'user', content: 'keep this durable request', timestamp: 1 },
    ];
    await session.appendMessage(messages[0]!);
    const flush = vi.fn(async () => undefined);

    await expect(
      acquireDurableCompactionSession(messages, {
        ...fence,
        flush,
        getSession: () => session,
        isLeaseLost: () => false,
      }),
    ).resolves.toBe(session);
    expect(flush).toHaveBeenCalledOnce();
  });

  it('compares the repaired durable view so a read-time orphan receipt is legal', async () => {
    const session = await new InMemorySessionRepo().create({ id: fence.sessionId });
    const durable = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'read_scene', arguments: {} }],
        stopReason: 'toolUse',
        timestamp: 1,
      },
    ] as unknown as AgentMessage[];
    await session.appendMessage(durable[0]!);
    const repaired = repairOrphanedToolCalls(durable).messages;

    await expect(
      acquireDurableCompactionSession(repaired, {
        ...fence,
        flush: async () => undefined,
        getSession: () => session,
        isLeaseLost: () => false,
      }),
    ).resolves.toBe(session);
  });

  it('accepts a compacted durable tail that covers the raw agent state', async () => {
    const session = await new InMemorySessionRepo().create({ id: fence.sessionId });
    const messages: AgentMessage[] = [
      { role: 'user', content: 'old request', timestamp: 1 },
      { role: 'user', content: 'retained follow-up', timestamp: 2 },
      { role: 'user', content: 'next tool round', timestamp: 3 },
    ];
    await session.appendMessage(messages[0]!);
    await session.appendMessage(messages[1]!);
    const branch = await session.getBranch();
    await session.appendCompaction('summary of old request', branch[1]!.id, 100);
    await session.appendMessage(messages[2]!);

    await expect(
      acquireDurableCompactionSession(messages, {
        ...fence,
        flush: async () => undefined,
        getSession: () => session,
        isLeaseLost: () => false,
      }),
    ).resolves.toBe(session);
  });

  it('accepts a stable repaired orphan after an existing compaction boundary', async () => {
    const session = await new InMemorySessionRepo().create({ id: fence.sessionId });
    const old = { role: 'user', content: 'old request', timestamp: 1 } as AgentMessage;
    const orphan = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'read_scene', arguments: {} }],
      stopReason: 'toolUse',
      timestamp: 2,
    } as unknown as AgentMessage;
    await session.appendMessage(old);
    const branch = await session.getBranch();
    await session.appendCompaction('summary of old request', branch[0]!.id, 100);
    await session.appendMessage(orphan);

    const modelMessages = repairOrphanedToolCalls((await session.buildContext()).messages).messages;
    await expect(
      acquireDurableCompactionSession(modelMessages, {
        ...fence,
        flush: async () => undefined,
        getSession: () => session,
        isLeaseLost: () => false,
      }),
    ).resolves.toBe(session);
  });

  it('ignores the repair time of a read-time receipt after a compaction boundary', async () => {
    const session = await new InMemorySessionRepo().create({ id: fence.sessionId });
    const old = { role: 'user', content: 'old request', timestamp: 1 } as AgentMessage;
    const orphan = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'read_scene', arguments: {} }],
      stopReason: 'toolUse',
      timestamp: 2,
    } as unknown as AgentMessage;
    await session.appendMessage(old);
    const branch = await session.getBranch();
    await session.appendCompaction('summary of old request', branch[0]!.id, 100);
    await session.appendMessage(orphan);

    // The run-start repair happened earlier than the acquire-time repair.
    const modelMessages = repairOrphanedToolCalls(
      (await session.buildContext()).messages,
      () => 1,
    ).messages;
    await expect(
      acquireDurableCompactionSession(modelMessages, {
        ...fence,
        flush: async () => undefined,
        getSession: () => session,
        isLeaseLost: () => false,
      }),
    ).resolves.toBe(session);
  });

  it('fails closed on an incomplete tree or a lost lease generation', async () => {
    const session = await new InMemorySessionRepo().create({ id: fence.sessionId });
    const messages: AgentMessage[] = [{ role: 'user', content: 'not durable yet', timestamp: 1 }];

    await expect(
      acquireDurableCompactionSession(messages, {
        ...fence,
        flush: async () => undefined,
        getSession: () => session,
        isLeaseLost: () => false,
      }),
    ).rejects.toThrow('entry tree is incomplete at compaction boundary (0/1 messages)');

    await expect(
      acquireDurableCompactionSession(messages, {
        ...fence,
        flush: async () => undefined,
        getSession: () => session,
        isLeaseLost: () => true,
      }),
    ).rejects.toBeInstanceOf(AgentSessionLeaseLostError);
  });
});
