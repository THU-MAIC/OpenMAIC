import { describe, expect, expectTypeOf, test } from 'vitest';

import {
  AGENT_SESSION_LIFECYCLE,
  AgentSessionEntryTreeError,
  AgentSessionLeaseLostError,
  type AgentSessionEntryTree,
  type AgentSessionEventLog,
  type AgentSessionMessageEntry,
  type AgentSessionStore,
  type OwnerSessionEventProjection,
} from '../src/agent-session/types.js';

export type AgentSessionContractStore = AgentSessionStore &
  AgentSessionEventLog &
  AgentSessionEntryTree &
  OwnerSessionEventProjection;

export function makeAgentSessionInput(
  overrides: Partial<Parameters<AgentSessionStore['createSession']>[0]> = {},
) {
  return {
    id: 'session-1',
    ownerId: 'owner-a',
    prompt: 'Build a short course',
    stageId: 'stage-1',
    ...overrides,
  };
}

/**
 * Backend-neutral, single-process semantics. These checks intentionally avoid
 * claims that need two simultaneously open database connections; those live
 * in the concurrency contract so a serialized embedded backend can still
 * prove CRUD, fencing, replay, tree, and projection behavior.
 */
export function runAgentSessionStoreContract(
  name: string,
  makeStore: () => AgentSessionContractStore,
): void {
  describe(`AgentSessionStore contract: ${name}`, () => {
    async function settleOnQuestion(store: AgentSessionContractStore): Promise<void> {
      await store.createSession(makeAgentSessionInput());
      const claim = await store.claimNextSession('ask-worker', 101, {
        leaseTtlMs: 10_000,
        maxAttempts: 3,
      });
      expect(claim).not.toBeNull();
      await store.appendRunEvent('session-1', 'ask-worker', {
        ts: 2,
        attempt: claim!.attempt,
        type: AGENT_SESSION_LIFECYCLE.userQuestion,
        data: { question: 'Continue?' },
      });
      await store.finishSession('session-1', 'ask-worker', {
        status: 'succeeded',
        resetAttempt: true,
        expectedAttempt: claim!.attempt,
      });
    }

    test('creates, reads, and lists sessions', async () => {
      const store = makeStore();
      const created = await store.createSession(
        makeAgentSessionInput({ skillId: 'skill-a', origin: 'https://example.test' }),
      );

      expect(created).toMatchObject({
        id: 'session-1',
        ownerId: 'owner-a',
        stageId: 'stage-1',
        skillId: 'skill-a',
        status: 'queued',
        attempt: 0,
      });
      expect(await store.getSession('session-1')).toEqual(created);
      expect(await store.listSessionsByOwner('owner-a')).toEqual([created]);
    });

    test('tombstones only through the owner and hides all public child reads', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      await store.appendControlEvent('session-1', {
        ts: 1,
        type: 'control',
        data: { retained: true },
      });

      expect(await store.softDeleteSession('session-1', 'owner-b')).toBe(false);
      expect(await store.softDeleteSession('session-1', 'owner-a')).toBe(true);
      expect(await store.softDeleteSession('session-1', 'owner-a')).toBe(false);
      expect(await store.getSession('session-1')).toBeNull();
      expect(await store.listSessionsByOwner('owner-a')).toEqual([]);
      expect(await store.readEventsAfter('session-1', 0)).toEqual([]);
    });

    test('claims, heartbeats, finishes, and rejects stale lease writes', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      const claim = await store.claimNextSession('worker-a', 101, {
        leaseTtlMs: 10_000,
        maxAttempts: 3,
      });
      expect(claim).toMatchObject({
        id: 'session-1',
        status: 'running',
        attempt: 1,
        claimReason: 'queued',
        claimSeq: 0,
      });
      expect(await store.heartbeat('session-1', 'worker-a')).toBe(true);
      const messageSeq = await store.appendUserMessage('session-1', {
        text: 'Opening prompt',
        delivery: 'steer',
      });
      expect(await store.markUserMessageDelivered('session-1', 'worker-b', 1, messageSeq)).toBe(
        false,
      );
      expect(await store.markUserMessageDelivered('session-1', 'worker-a', 2, messageSeq)).toBe(
        false,
      );
      expect(await store.markUserMessageDelivered('session-1', 'worker-a', 1, messageSeq)).toBe(
        true,
      );
      expect(await store.getSession('session-1')).toMatchObject({
        deliveredUserMessageSeq: messageSeq,
      });
      expect(await store.markUserMessageDelivered('session-1', 'worker-a', 1, 0)).toBe(true);
      expect(await store.getSession('session-1')).toMatchObject({
        deliveredUserMessageSeq: messageSeq,
      });
      expect(
        await store.appendRunEvent('session-1', 'worker-a', {
          ts: 2,
          attempt: 0,
          type: 'stale',
          data: null,
        }),
      ).toBeNull();
      expect(
        await store.appendRunEvent('session-1', 'worker-b', {
          ts: 2,
          attempt: 1,
          type: 'wrong-worker',
          data: null,
        }),
      ).toBeNull();
      expect(
        await store.appendRunEvent('session-1', 'worker-a', {
          ts: 3,
          attempt: 1,
          type: AGENT_SESSION_LIFECYCLE.sessionStart,
          data: { ok: true },
        }),
      ).toBe(2);
      expect(await store.finishSession('session-1', 'worker-b', { status: 'failed' })).toBe(false);
      expect(
        await store.finishSession('session-1', 'worker-a', {
          status: 'succeeded',
          resetAttempt: true,
        }),
      ).toBe(true);
      expect(await store.heartbeat('session-1', 'worker-a')).toBe(false);
      expect(await store.markUserMessageDelivered('session-1', 'worker-a', 1, messageSeq + 1)).toBe(
        false,
      );
      expect(await store.getSession('session-1')).toMatchObject({
        status: 'succeeded',
        attempt: 0,
      });
    });

    test('keeps a material-only message queued behind an outstanding ask', async () => {
      const store = makeStore();
      await settleOnQuestion(store);

      await store.postUserMessage('session-1', {
        text: '',
        materials: [{ materialId: 'material-1', originalName: 'notes.pdf' }],
      });

      expect(await store.getSession('session-1')).toMatchObject({ status: 'queued' });
      await expect(
        store.claimNextSession('material-worker', 102, {
          leaseTtlMs: 10_000,
          maxAttempts: 3,
        }),
      ).resolves.toBeNull();
    });

    test('an answer after queued material resumes the ask exactly once', async () => {
      const store = makeStore();
      await settleOnQuestion(store);
      await store.postUserMessage('session-1', {
        text: '',
        materials: [{ materialId: 'material-1' }],
      });
      await store.postUserMessage('session-1', { text: 'Continue' });

      const resumed = await store.claimNextSession('answer-worker', 102, {
        leaseTtlMs: 10_000,
        maxAttempts: 3,
      });
      expect(resumed).toMatchObject({ id: 'session-1', claimReason: 'queued' });
      await expect(
        store.claimNextSession('duplicate-worker', 103, {
          leaseTtlMs: 10_000,
          maxAttempts: 3,
        }),
      ).resolves.toBeNull();
    });

    test('a plain user message deterministically supersedes an outstanding ask', async () => {
      const store = makeStore();
      await settleOnQuestion(store);
      await store.postUserMessage('session-1', { text: 'Ignore that; change the title instead.' });

      const resumed = await store.claimNextSession('supersede-worker', 102, {
        leaseTtlMs: 10_000,
        maxAttempts: 3,
      });
      expect(resumed).toMatchObject({ id: 'session-1', claimReason: 'queued' });
    });

    test('a pending cancellation outranks the outstanding-ask claim fence', async () => {
      const store = makeStore();
      await settleOnQuestion(store);
      await store.postUserMessage('session-1', { text: '', materials: [{ materialId: 'm1' }] });
      await store.requestCancel('session-1');

      await expect(
        store.claimNextSession('cancel-worker', 102, {
          leaseTtlMs: 10_000,
          maxAttempts: 3,
        }),
      ).resolves.toBeNull();
      expect(await store.getSession('session-1')).toMatchObject({ status: 'cancelled' });
    });

    test('appends ordered events and compacts only middle message updates on replay', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      for (const [index, type] of [
        'before',
        'message_update',
        'message_update',
        'message_update',
        'after',
      ].entries()) {
        await store.appendControlEvent('session-1', {
          ts: index + 1,
          type,
          data: { index },
        });
      }
      expect(await store.lastEventSeq('session-1')).toBe(5);
      expect((await store.readEventsAfter('session-1', 1)).map((event) => event.id)).toEqual([
        2, 3, 4, 5,
      ]);
      const replay = await store.readEventsAfterForReplay('session-1', 0);
      expect(replay.scanned).toBe(5);
      expect(replay.events.map((event) => event.id)).toEqual([1, 2, 4, 5]);
    });

    test('prunes only middle updates from the completed message immediately before its end', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      const frames = [
        { type: 'message_start', data: { message: { role: 'assistant', content: [] } } },
        ...Array.from({ length: 5 }, (_, index) => ({
          type: 'message_update',
          data: {
            message: { role: 'assistant', content: [{ type: 'text', text: `part-${index}` }] },
          },
        })),
        { type: 'message_end', data: { message: { role: 'assistant', content: [] } } },
        { type: 'tool_execution_end', data: { toolCallId: 'tool-1' } },
        { type: 'message_start', data: { message: { role: 'assistant', content: [] } } },
        ...Array.from({ length: 3 }, (_, index) => ({
          type: 'message_update',
          data: {
            message: { role: 'assistant', content: [{ type: 'text', text: `next-${index}` }] },
          },
        })),
      ];
      for (const [index, frame] of frames.entries()) {
        await store.appendControlEvent('session-1', { ts: index + 1, ...frame });
      }

      const before = await store.readEventsAfterForReplay('session-1', 0);
      expect(await store.pruneMessageUpdates('session-1', 7)).toBe(3);
      expect(await store.pruneMessageUpdates('session-1', 7)).toBe(0);

      const raw = await store.readEventsAfter('session-1', 0);
      expect(raw.map((event) => [event.id, event.type])).toEqual([
        [1, 'message_start'],
        [2, 'message_update'],
        [6, 'message_update'],
        [7, 'message_end'],
        [8, 'tool_execution_end'],
        [9, 'message_start'],
        [10, 'message_update'],
        [11, 'message_update'],
        [12, 'message_update'],
      ]);
      const after = await store.readEventsAfterForReplay('session-1', 0);
      expect(after.events).toEqual(before.events);
    });

    test('prunes every update run separated by reasoning and tool lifecycle events', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      const updates = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, index) => ({
          type: 'message_update',
          data: {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `${prefix}-${index}` }],
            },
          },
        }));
      const frames = [
        { type: 'message_start', data: { message: { role: 'assistant', content: [] } } },
        ...updates('reasoning', 5),
        { type: 'thinking_end', data: {} },
        ...updates('answer', 4),
        { type: 'tool_execution_start', data: { toolCallId: 'tool-1' } },
        { type: 'tool_execution_end', data: { toolCallId: 'tool-1' } },
        ...updates('after-tool', 3),
        { type: 'message_end', data: { message: { role: 'assistant', content: [] } } },
      ];
      for (const [index, frame] of frames.entries()) {
        await store.appendControlEvent('session-1', { ts: index + 1, ...frame });
      }

      const before = await store.readEventsAfterForReplay('session-1', 0);
      expect(await store.pruneMessageUpdates('session-1', 17)).toBe(6);
      expect(await store.pruneMessageUpdates('session-1', 17)).toBe(0);

      const raw = await store.readEventsAfter('session-1', 0);
      expect(raw.map((event) => [event.id, event.type])).toEqual([
        [1, 'message_start'],
        [2, 'message_update'],
        [6, 'message_update'],
        [7, 'thinking_end'],
        [8, 'message_update'],
        [11, 'message_update'],
        [12, 'tool_execution_start'],
        [13, 'tool_execution_end'],
        [14, 'message_update'],
        [16, 'message_update'],
        [17, 'message_end'],
      ]);
      const after = await store.readEventsAfterForReplay('session-1', 0);
      expect(after.events).toEqual(before.events);
    });

    test('carries first-and-last message_update compaction across page boundaries', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      // One non-update, a run of ten updates, then another non-update, read in
      // pages of six. Compaction ranks each PAGE (not the whole remainder):
      // the first row of a page has no left neighbour, so it is always kept —
      // that is what lets a live SSE tail forward a delta the moment it lands
      // (its `prev` is NULL at the page edge, so it can never be compacted
      // away). The extra middle frames at a boundary (6, 7) are harmless: the
      // workbench fold overwrites message_update text wholesale, and the last
      // frame of each page still carries the full text (reference semantics).
      for (const [index, type] of [
        'before',
        ...Array.from({ length: 10 }, () => 'message_update'),
        'after',
      ].entries()) {
        await store.appendControlEvent('session-1', {
          ts: index + 1,
          type,
          data: { index },
        });
      }
      expect(await store.lastEventSeq('session-1')).toBe(12);

      const first = await store.readEventsAfterForReplay('session-1', 0, 6);
      // `scanned` counts the raw rows after the cursor (12 total), untouched by
      // the compaction window; the page itself still returns at most `limit`.
      expect(first.scanned).toBe(12);
      expect(first.events.map((event) => event.id)).toEqual([1, 2, 6]);

      const second = await store.readEventsAfterForReplay('session-1', 6, 6);
      expect(second.scanned).toBe(6);
      expect(second.events.map((event) => event.id)).toEqual([7, 11, 12]);

      expect(
        [...first.events, ...second.events]
          .filter((event) => event.type === 'message_update')
          .map((event) => event.id),
      ).toEqual([2, 6, 7, 11]);
    });

    test('a live tail never starves: the first message_update after the cursor is always kept', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      // The cursor sits ON a message_update (the previous poll forwarded it).
      // A fresh burst of deltas arrives with no non-update neighbour on either
      // side. Page-local compaction must still forward the first frame — the
      // delta that proves the stream is alive — instead of compacting the
      // whole burst away because the cursor row happens to be an update too.
      for (const type of ['message_update', 'message_update', 'message_update']) {
        await store.appendControlEvent('session-1', {
          ts: 1,
          type,
          data: { text: 'delta' },
        });
      }
      const tail = await store.readEventsAfterForReplay('session-1', 0, 500);
      expect(tail.scanned).toBe(3);
      expect(tail.events.map((event) => event.id)).toEqual([1, 3]);
      // The first frame is never dropped, whatever the cursor row was: re-read
      // with the cursor on event 1 (a message_update) and a second delta.
      await store.appendControlEvent('session-1', { ts: 2, type: 'message_update', data: {} });
      const next = await store.readEventsAfterForReplay('session-1', 1, 500);
      expect(next.events.map((event) => event.id)).toEqual([2, 4]);
    });

    test('records control events with the current attempt generation', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      await store.claimNextSession('worker-a', 101, { leaseTtlMs: 10_000, maxAttempts: 3 });
      // The attempt is derived from the parent row under the lock (reference
      // material-event semantics), never accepted from the caller.
      const seq = await store.appendControlEvent('session-1', {
        ts: 5,
        type: 'control',
        data: { ok: true },
      });
      expect(seq).toBe(1);
      expect(await store.readEventsAfter('session-1', 0)).toMatchObject([
        { id: 1, ts: 5, attempt: 1, type: 'control' },
      ]);
    });

    test('classifies posted messages and atomically revives terminal sessions', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput({ status: 'succeeded' }));
      const idle = await store.postUserMessage('session-1', { text: 'Continue' });
      expect(idle).toMatchObject({ delivery: 'queued', requeued: true, seq: 1 });
      expect(await store.getSession('session-1')).toMatchObject({ status: 'queued', attempt: 0 });
      expect(await store.listUserMessages('session-1')).toMatchObject([
        { seq: 1, text: 'Continue', delivery: 'queued' },
      ]);

      await store.claimNextSession('worker-a', 101, { leaseTtlMs: 10_000, maxAttempts: 3 });
      const live = await store.postUserMessage('session-1', { text: 'Add a quiz' });
      expect(live).toMatchObject({ delivery: 'steer', requeued: false, seq: 2 });
      expect(await store.getSession('session-1')).toMatchObject({ status: 'running' });
    });

    test('supports cancellation and distinct attended and unattended requeues', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      await store.claimNextSession('worker-a', 101, { leaseTtlMs: 10_000, maxAttempts: 3 });
      await store.requestCancel('session-1');
      await store.requestCancel('session-1');
      expect(await store.isCancelRequested('session-1')).toBe(true);
      const requestedAt = await store.getCancelRequestedAt('session-1');
      expect(requestedAt).not.toBeNull();
      await expect(store.clearCancel('session-1', 'worker-a', 1, requestedAt!)).resolves.toBe(true);
      expect(await store.isCancelRequested('session-1')).toBe(false);

      await store.finishSession('session-1', 'worker-a', { status: 'failed', error: 'failure' });
      expect(await store.requeueForRetry('session-1')).toBe(true);
      expect(await store.getSession('session-1')).toMatchObject({ status: 'queued', attempt: 1 });
      await store.claimNextSession('worker-a', 101, { leaseTtlMs: 10_000, maxAttempts: 3 });
      await store.finishSession('session-1', 'worker-a', { status: 'failed' });
      expect(await store.requeueSession('session-1')).toBe(true);
      expect(await store.requeueSession('session-1')).toBe(false);
      expect(await store.getSession('session-1')).toMatchObject({ status: 'queued', attempt: 0 });
    });

    test('a stale cancellation cleanup cannot erase a newer attempt request', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      await store.claimNextSession('worker-a', 101, { leaseTtlMs: 10_000, maxAttempts: 3 });
      await store.requestCancel('session-1');
      const firstRequest = await store.getCancelRequestedAt('session-1');
      expect(firstRequest).not.toBeNull();

      await expect(
        store.finishSession('session-1', 'worker-a', {
          status: 'cancelled',
          resetAttempt: true,
          expectedAttempt: 1,
          consumeCancelRequestedAt: firstRequest!,
        }),
      ).resolves.toBe(true);
      await store.postUserMessage('session-1', { text: 'Run again' });
      await store.claimNextSession('worker-b', 202, { leaseTtlMs: 10_000, maxAttempts: 3 });
      await store.requestCancel('session-1');

      await expect(store.clearCancel('session-1', 'worker-a', 1, firstRequest!)).resolves.toBe(
        false,
      );
      expect(await store.isCancelRequested('session-1')).toBe(true);
    });

    test('settles a cancel-requested queued session as cancelled on claim, never leasing it', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      await store.requestCancel('session-1');
      expect(await store.isCancelRequested('session-1')).toBe(true);

      const claim = await store.claimNextSession('worker-a', 101, {
        leaseTtlMs: 10_000,
        maxAttempts: 3,
      });
      // The scan must not lease the session for another attempt: it settles
      // the pending cancel under the claim lock and moves on.
      expect(claim).toBeNull();

      const meta = await store.getSession('session-1');
      expect(meta).toMatchObject({ status: 'cancelled', attempt: 0 });
      expect(meta?.lease).toBeUndefined();
      expect(await store.isCancelRequested('session-1')).toBe(false);
      // The event log carries the terminal frame and the owner projection
      // records the terminal status, exactly like the runner's cancel path.
      const events = await store.readEventsAfter('session-1', 0);
      expect(events.at(-1)).toMatchObject({ type: AGENT_SESSION_LIFECYCLE.sessionEnd });
      expect((events.at(-1)?.data as { status?: unknown } | undefined)?.status).toBe('cancelled');
      const projection = await store.readAfter('owner-a', BigInt(0));
      expect(projection.at(-1)).toMatchObject({
        type: 'session_status',
        status: 'cancelled',
        attempt: 0,
      });
    });

    test('appends and reopens an entry tree with labels, paths, and leaf markers', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      await store.claimNextSession('worker-a', 101, { leaseTtlMs: 10_000, maxAttempts: 3 });
      const tree = await store.openEntryTree('session-1', 'worker-a', 1);
      await tree.appendEntry({
        id: 'root',
        parentId: null,
        type: 'message',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'Hello' },
      });
      await tree.appendEntry({
        id: 'child',
        parentId: 'root',
        type: 'custom_message',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'assistant', content: 'Hi' },
      });
      await tree.appendEntry({
        id: 'label',
        parentId: 'child',
        type: 'label',
        timestamp: '2026-01-01T00:00:02.000Z',
        targetId: 'child',
        label: 'Answer',
      });
      expect(await tree.getLabel('child')).toBe('Answer');
      expect((await tree.getPathToRoot('child')).map((entry) => entry.id)).toEqual([
        'root',
        'child',
      ]);
      await tree.setLeafId('child');
      expect(await tree.getLeafId()).toBe('child');

      const reopened = await store.openEntryTree('session-1', 'worker-a', 1);
      expect(await reopened.getLeafId()).toBe('child');
      // `findEntries` keeps the reference's narrowing: a 'message' query
      // yields exactly AgentSessionMessageEntry[] (compile-time pinned).
      const messages = await reopened.findEntries('message');
      expectTypeOf(messages).toEqualTypeOf<AgentSessionMessageEntry[]>();
      expect(messages.map((entry) => entry.id)).toEqual(['root']);
      await expect(
        reopened.appendEntry({
          id: 'dangling',
          parentId: 'missing',
          type: 'message',
          timestamp: '2026-01-01T00:00:03.000Z',
          message: {},
        }),
      ).rejects.toBeInstanceOf(AgentSessionEntryTreeError);
    });

    test('fences an already-open tree after a newer claim', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      await store.claimNextSession('worker-a', 101, { leaseTtlMs: 10_000, maxAttempts: 3 });
      const tree = await store.openEntryTree('session-1', 'worker-a', 1);
      await store.releaseLease('session-1', 'worker-a');
      await store.claimNextSession('worker-b', 102, { leaseTtlMs: 10_000, maxAttempts: 3 });
      await expect(
        tree.appendEntry({
          id: 'late',
          parentId: null,
          type: 'message',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: {},
        }),
      ).rejects.toBeInstanceOf(AgentSessionLeaseLostError);
    });

    test('maintains a sparse per-owner projection and its durable counter', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      await store.requestCancel('session-1');
      const events = await store.readAfter('owner-a', BigInt(0));
      expect(events.map((event) => event.type)).toEqual([
        'session_created',
        'session_cancel_requested',
      ]);
      expect(events.map((event) => event.id)).toEqual(['1', '2']);
      expect(await store.readMaxId('owner-a')).toBe(BigInt(2));
      expect(await store.readRetirement('owner-a')).toBeNull();
    });

    test('moves sessions and renumbers source projection events above the target high water', async () => {
      const store = makeStore();
      await store.createSession(makeAgentSessionInput());
      await store.createSession(
        makeAgentSessionInput({ id: 'session-2', ownerId: 'owner-b', stageId: 'stage-2' }),
      );
      await store.requestCancel('session-1');
      expect(await store.mergeOwner('owner-a', 'owner-b')).toBe(1);
      expect(await store.listSessionsByOwner('owner-a')).toEqual([]);
      expect((await store.listSessionsByOwner('owner-b')).map((session) => session.id)).toEqual([
        'session-1',
        'session-2',
      ]);
      const targetEvents = await store.readAfter('owner-b', BigInt(0));
      expect(targetEvents.map((event) => event.id)).toEqual(['1', '3', '4']);
      expect(await store.readMaxId('owner-b')).toBe(BigInt(4));
      expect(await store.mergeOwner('owner-a', 'owner-b')).toBe(0);
    });
  });
}
