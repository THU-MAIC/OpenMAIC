import type { PersistedAgentSessionEvent } from '@openmaic/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  listAgentUserMessages,
  readAgentMessageLog,
} from '@/lib/server/agent-runtime/user-messages';

describe('readAgentMessageLog', () => {
  it('replays recovery boundaries across pages without losing user message context', async () => {
    const events: PersistedAgentSessionEvent[] = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      ts: 1,
      attempt: 1,
      type: 'trace',
      data: {},
    }));
    events.push(
      {
        id: 501,
        ts: 2,
        attempt: 1,
        type: 'skill_detached',
        data: { skillName: 'my-method', throughMessageSeq: 42 },
      },
      {
        id: 502,
        ts: 3,
        attempt: 0,
        type: 'user_message',
        data: {
          text: '/my-method new selection',
          delivery: 'follow_up',
          materials: [],
          elementRefs: [{ id: 'element-1' }],
          courseRefs: [{ id: 'course-1' }],
          locale: 'zh-CN',
        },
      },
    );
    const store = {
      readEventsAfter: vi.fn(async (_id: string, after: number, limit = 500) =>
        events.filter((event) => event.id > after).slice(0, limit),
      ),
      listUserMessages: vi.fn(async () => []),
    };
    const log = await readAgentMessageLog(store, 'session-1');
    expect(log.detachedSkills).toEqual([{ skillName: 'my-method', throughMessageSeq: 42 }]);
    expect(log.messages).toEqual([
      {
        seq: 502,
        ts: 3,
        text: '/my-method new selection',
        delivery: 'follow_up',
        materials: [],
        elementRefs: [{ id: 'element-1' }],
        courseRefs: [{ id: 'course-1' }],
        locale: 'zh-CN',
      },
    ]);
    expect(store.readEventsAfter).toHaveBeenNthCalledWith(2, 'session-1', 500, 500);
    expect(await listAgentUserMessages(store, 'session-1')).toEqual(log.messages);
    expect(store.listUserMessages).not.toHaveBeenCalled();
  });

  it('ignores malformed recovery receipts', async () => {
    const data = [
      null,
      [],
      {},
      { skillName: 'my-method', throughMessageSeq: -1 },
      { skillName: 'my-method', throughMessageSeq: 1.5 },
    ];
    const store = {
      readEventsAfter: vi.fn(async () =>
        data.map((value, i) => ({
          id: i + 1,
          ts: 1,
          attempt: 1,
          type: 'skill_detached',
          data: value,
        })),
      ),
      listUserMessages: vi.fn(async () => []),
    };
    expect(await readAgentMessageLog(store, 'session-1')).toEqual({
      messages: [],
      detachedSkills: [],
    });
  });

  it.each(['session_start', 'session_resumed', 'session_end', 'session_interrupted'])(
    'does not mistake a follow-up after %s for a durable opener',
    async (type) => {
      const store = {
        readEventsAfter: vi.fn(async () => [
          { id: 1, ts: 1, attempt: 1, type, data: {} },
          { id: 2, ts: 2, attempt: 0, type: 'user_message', data: { text: 'new selection' } },
        ]),
        listUserMessages: vi.fn(async () => []),
      };
      expect(await readAgentMessageLog(store, 'session-1')).not.toHaveProperty('openingMessageSeq');
      store.readEventsAfter.mockResolvedValue([
        { id: 1, ts: 1, attempt: 0, type: 'user_message', data: { text: 'opening context' } },
        { id: 2, ts: 2, attempt: 1, type, data: {} },
      ]);
      expect(await readAgentMessageLog(store, 'session-1')).toHaveProperty('openingMessageSeq', 1);
    },
  );

  it('reports the interruption reason only when the log ENDS on that interruption', async () => {
    const store = (events: PersistedAgentSessionEvent[]) => ({
      readEventsAfter: vi.fn(async (_id: string, after: number) =>
        events.filter((event) => event.id > after),
      ),
      listUserMessages: vi.fn(async () => []),
    });
    const boundary = (id: number, type: string, data: Record<string, unknown> = {}) => ({
      id,
      ts: id,
      attempt: 1,
      type,
      data,
    });

    // A clean step-boundary handoff is the last thing written: the next claim
    // resumes it silently.
    expect(
      await readAgentMessageLog(
        store([
          boundary(1, 'session_start', { prompt: 'p' }),
          boundary(2, 'session_interrupted', { reason: 'clean handoff' }),
        ]),
        'session-1',
      ),
    ).toHaveProperty('lastInterruptedReason', 'clean handoff');

    // A forced handoff keeps its own reason; the runner only special-cases the
    // clean one.
    expect(
      await readAgentMessageLog(
        store([boundary(1, 'session_interrupted', { reason: 'runner shutdown' })]),
        'session-1',
      ),
    ).toHaveProperty('lastInterruptedReason', 'runner shutdown');

    // A crash leaves NO event: the dead run's own `session_resumed` is the last
    // boundary, so an OLDER clean handoff must not be mistaken for this one.
    expect(
      await readAgentMessageLog(
        store([
          boundary(1, 'session_interrupted', { reason: 'clean handoff' }),
          boundary(2, 'session_resumed', { reason: 'clean_handoff' }),
          boundary(3, 'user_message', { text: 'another turn' }),
        ]),
        'session-1',
      ),
    ).not.toHaveProperty('lastInterruptedReason');

    // The same for a run that ended and then started another run.
    expect(
      await readAgentMessageLog(
        store([
          boundary(1, 'session_interrupted', { reason: 'clean handoff' }),
          boundary(2, 'session_end', { status: 'succeeded' }),
          boundary(3, 'session_start', { prompt: 'p' }),
        ]),
        'session-1',
      ),
    ).not.toHaveProperty('lastInterruptedReason');

    // An interruption without a reason is not a clean handoff.
    expect(
      await readAgentMessageLog(store([boundary(1, 'session_interrupted', {})]), 'session-1'),
    ).not.toHaveProperty('lastInterruptedReason');
  });
});
