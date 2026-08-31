import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  getAgentSessionStore: vi.fn(),
  generateConversationTitle: vi.fn(),
  logError: vi.fn(),
  claimAutomaticSessionTitle: vi.fn(),
  setAutomaticSessionTitle: vi.fn(),
}));

vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: mocks.getAgentSessionStore,
}));
vi.mock('@/lib/server/agent-runtime/conversation-title-generator', () => ({
  generateConversationTitle: mocks.generateConversationTitle,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: mocks.logError }),
}));

import { scheduleConversationTitle } from '@/lib/server/agent-runtime/conversation-title-task';

async function runScheduledTask(): Promise<void> {
  expect(mocks.after).toHaveBeenCalledOnce();
  const callback = mocks.after.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
  expect(callback).toBeTypeOf('function');
  await callback?.();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAgentSessionStore.mockResolvedValue({
    claimAutomaticSessionTitle: mocks.claimAutomaticSessionTitle,
    setAutomaticSessionTitle: mocks.setAutomaticSessionTitle,
  });
  mocks.claimAutomaticSessionTitle.mockResolvedValue('Durable first user message');
  mocks.generateConversationTitle.mockResolvedValue('Generated title');
  mocks.setAutomaticSessionTitle.mockResolvedValue({ id: 'session-1', title: 'Generated title' });
});

describe('conversation title task', () => {
  it('keeps title scheduling failures out of the request path', () => {
    mocks.after.mockImplementationOnce(() => {
      throw new Error('waitUntil unavailable');
    });

    expect(() => scheduleConversationTitle('session-1', 'owner-1')).not.toThrow();
    expect(mocks.logError).toHaveBeenCalledWith(
      'session session-1: automatic title scheduling failed',
      expect.any(Error),
    );
  });

  it('defers all work, then claims durable text before generating and guarded-committing', async () => {
    const order: string[] = [];
    mocks.getAgentSessionStore.mockImplementation(async () => {
      order.push('store');
      return {
        claimAutomaticSessionTitle: async (sessionId: string, ownerId: string) => {
          order.push(`claim:${sessionId}:${ownerId}`);
          return 'Durable text from storage';
        },
        setAutomaticSessionTitle: async (sessionId: string, ownerId: string, title: string) => {
          order.push(`commit:${sessionId}:${ownerId}:${title}`);
          return { id: sessionId, title };
        },
      };
    });
    mocks.generateConversationTitle.mockImplementation(async (text: string) => {
      order.push(`generate:${text}`);
      return 'Stored-text title';
    });

    scheduleConversationTitle('session-7', 'owner-9');

    expect(order).toEqual([]);
    await runScheduledTask();
    expect(order).toEqual([
      'store',
      'claim:session-7:owner-9',
      'generate:Durable text from storage',
      'commit:session-7:owner-9:Stored-text title',
    ]);
  });

  it('stops normally when no durable text can be claimed', async () => {
    mocks.claimAutomaticSessionTitle.mockResolvedValue(null);

    scheduleConversationTitle('session-1', 'owner-1');
    await runScheduledTask();

    expect(mocks.generateConversationTitle).not.toHaveBeenCalled();
    expect(mocks.setAutomaticSessionTitle).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('leaves the claimed automatic-null state unchanged when generation returns no title', async () => {
    mocks.generateConversationTitle.mockResolvedValue(null);

    scheduleConversationTitle('session-1', 'owner-1');
    await runScheduledTask();

    expect(mocks.setAutomaticSessionTitle).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('treats a refused guarded commit as a normal no-op', async () => {
    mocks.setAutomaticSessionTitle.mockResolvedValue(null);

    scheduleConversationTitle('session-1', 'owner-1');
    await runScheduledTask();

    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it.each([
    [
      'store reload',
      () => mocks.getAgentSessionStore.mockRejectedValue(new Error('store unavailable')),
      () => expect(mocks.claimAutomaticSessionTitle).not.toHaveBeenCalled(),
    ],
    [
      'durable claim',
      () => mocks.claimAutomaticSessionTitle.mockRejectedValue(new Error('claim failed')),
      () => expect(mocks.generateConversationTitle).not.toHaveBeenCalled(),
    ],
    [
      'generation',
      () => mocks.generateConversationTitle.mockRejectedValue(new Error('model failed')),
      () => expect(mocks.setAutomaticSessionTitle).not.toHaveBeenCalled(),
    ],
    [
      'guarded commit',
      () => mocks.setAutomaticSessionTitle.mockRejectedValue(new Error('commit failed')),
      () => expect(mocks.setAutomaticSessionTitle).toHaveBeenCalledOnce(),
    ],
  ])(
    'catches and logs a %s failure without rejecting the scheduled callback',
    async (_label, fail, check) => {
      fail();

      scheduleConversationTitle('session-1', 'owner-1');
      await expect(runScheduledTask()).resolves.toBeUndefined();

      check();
      expect(mocks.logError).toHaveBeenCalledOnce();
    },
  );
});
