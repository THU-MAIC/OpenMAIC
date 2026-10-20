import { describe, expect, test } from 'vitest';

import {
  AGENT_SESSION_LIFECYCLE,
  AgentSessionExternalWriterError,
  type AgentSessionExternalWriterStore,
  type AgentSessionTransaction,
} from '../src/agent-session/types.js';
import type { AgentSessionContractStore } from './agent-session-contract.js';
import { makeAgentSessionInput } from './agent-session-contract.js';

export type AgentSessionExternalWriterContractStore = AgentSessionContractStore &
  AgentSessionExternalWriterStore;

export type InTransaction = <T>(body: (tx: AgentSessionTransaction) => Promise<T>) => Promise<T>;

const WRITER = 'generation-run:run-1';
const CLAIM = { leaseTtlMs: 10_000, maxAttempts: 3 };

class RollbackProbe extends Error {}

/**
 * The external-writer mark, on a single connection: what a marked session
 * refuses, what its writer may append, and that every write commits or rolls
 * back with the caller's transaction. The races against a concurrent holder of
 * the session row lock need two connections and live in the PostgreSQL suite.
 */
export function runAgentSessionExternalWriterContract(
  name: string,
  makeStore: () => AgentSessionExternalWriterContractStore,
  inTransaction: InTransaction,
): void {
  describe(`AgentSession external-writer contract: ${name}`, () => {
    const createMarked = (store: AgentSessionExternalWriterContractStore) =>
      inTransaction((tx) =>
        store.createSessionIn(tx, { ...makeAgentSessionInput(), externalWriter: WRITER }),
      );

    test('creates a marked session idle in the caller transaction', async () => {
      const store = makeStore();
      const meta = await createMarked(store);
      expect(meta).toMatchObject({ id: 'session-1', status: 'succeeded', externalWriter: WRITER });
      expect(await store.getSession('session-1')).toMatchObject({ externalWriter: WRITER });
      expect(await store.listSessionsByOwner('owner-a')).toEqual([meta]);
      expect(await store.readAfter('owner-a', BigInt(0))).toEqual([
        expect.objectContaining({ type: 'session_created', status: 'succeeded', attempt: 0 }),
      ]);
    });

    test('rolls the created session and its projection back with the caller', async () => {
      const store = makeStore();
      await expect(
        inTransaction(async (tx) => {
          await store.createSessionIn(tx, { ...makeAgentSessionInput(), externalWriter: WRITER });
          throw new RollbackProbe();
        }),
      ).rejects.toBeInstanceOf(RollbackProbe);
      expect(await store.getSession('session-1')).toBeNull();
      expect(await store.readAfter('owner-a', BigInt(0))).toEqual([]);
      expect(await store.readMaxId('owner-a')).toBe(BigInt(0));
    });

    test('refuses to create a marked session queued', async () => {
      const store = makeStore();
      await expect(
        inTransaction((tx) =>
          store.createSessionIn(tx, {
            ...makeAgentSessionInput(),
            status: 'queued',
            externalWriter: WRITER,
          }),
        ),
      ).rejects.toThrow(/created idle/);
      expect(await store.getSession('session-1')).toBeNull();
    });

    test('leaves unmarked sessions as they were', async () => {
      const store = makeStore();
      const created = await store.createSession(makeAgentSessionInput());
      expect(created).not.toHaveProperty('externalWriter');
      expect(created.status).toBe('queued');
      const viaTransaction = await inTransaction((tx) =>
        store.createSessionIn(tx, makeAgentSessionInput({ id: 'session-2' })),
      );
      expect(viaTransaction).not.toHaveProperty('externalWriter');
      expect(viaTransaction.status).toBe('queued');
    });

    test('refuses claims, messages, requeues, deletes and cancels while marked', async () => {
      const store = makeStore();
      await createMarked(store);

      expect(await store.claimNextSession('worker-a', 1, CLAIM)).toBeNull();
      expect(
        await store.claimNextSession('worker-a', 1, { ...CLAIM, sessionId: 'session-1' }),
      ).toBeNull();
      await expect(store.postUserMessage('session-1', { text: 'Edit it' })).rejects.toEqual(
        new AgentSessionExternalWriterError('session-1', WRITER),
      );
      await expect(
        store.postUserMessage('session-1', { text: 'Edit it' }, { expectedOwnerId: 'owner-a' }),
      ).rejects.toBeInstanceOf(AgentSessionExternalWriterError);
      await expect(
        store.appendUserMessage('session-1', { text: 'Edit it', delivery: 'queued' }),
      ).rejects.toBeInstanceOf(AgentSessionExternalWriterError);
      expect(await store.requeueSession('session-1')).toBe(false);
      expect(await store.requeueForRetry('session-1')).toBe(false);
      await expect(store.softDeleteSession('session-1', 'owner-a')).rejects.toBeInstanceOf(
        AgentSessionExternalWriterError,
      );
      await expect(store.requestCancel('session-1')).rejects.toBeInstanceOf(
        AgentSessionExternalWriterError,
      );

      expect(await store.getSession('session-1')).toMatchObject({
        status: 'succeeded',
        attempt: 0,
        externalWriter: WRITER,
      });
      expect(await store.lastEventSeq('session-1')).toBe(0);
      expect(await store.getCancelRequestedAt('session-1')).toBeNull();
      expect((await store.readAfter('owner-a', BigInt(0))).map((event) => event.type)).toEqual([
        'session_created',
      ]);
    });

    test('refuses a user message appended as a control event, and only that', async () => {
      const store = makeStore();
      await createMarked(store);
      await expect(
        store.appendControlEvent('session-1', {
          ts: 1,
          type: AGENT_SESSION_LIFECYCLE.userMessage,
          data: { text: 'Edit it', delivery: 'queued' },
        }),
      ).rejects.toEqual(new AgentSessionExternalWriterError('session-1', WRITER));
      expect(await store.lastEventSeq('session-1')).toBe(0);
      // Other control events (material extraction, library changes) still land.
      expect(
        await store.appendControlEvent('session-1', {
          ts: 2,
          type: AGENT_SESSION_LIFECYCLE.libraryChanged,
          data: {},
        }),
      ).toBe(1);
      expect(await store.getSession('session-1')).toMatchObject({
        externalWriter: WRITER,
        deliveredUserMessageSeq: 0,
      });
    });

    test('behaves like any other session once released', async () => {
      const store = makeStore();
      await createMarked(store);
      expect(
        await inTransaction((tx) => store.releaseExternalWriterIn(tx, 'session-1', WRITER)),
      ).toBe(true);
      expect(await store.getSession('session-1')).not.toHaveProperty('externalWriter');

      expect(await store.postUserMessage('session-1', { text: 'Edit it' })).toMatchObject({
        delivery: 'queued',
        requeued: true,
      });
      expect(
        await store.claimNextSession('worker-a', 1, { ...CLAIM, sessionId: 'session-1' }),
      ).toMatchObject({ id: 'session-1', status: 'running', claimReason: 'queued' });
      await store.requestCancel('session-1');
      expect(await store.isCancelRequested('session-1')).toBe(true);
      expect(await store.softDeleteSession('session-1', 'owner-a')).toBe(true);
    });

    test('releases only for its own writer, once', async () => {
      const store = makeStore();
      await createMarked(store);
      expect(
        await inTransaction((tx) => store.releaseExternalWriterIn(tx, 'session-1', 'other')),
      ).toBe(false);
      expect(await store.getSession('session-1')).toMatchObject({ externalWriter: WRITER });
      expect(
        await inTransaction((tx) => store.releaseExternalWriterIn(tx, 'session-1', WRITER)),
      ).toBe(true);
      expect(
        await inTransaction((tx) => store.releaseExternalWriterIn(tx, 'session-1', WRITER)),
      ).toBe(false);
      expect(
        await inTransaction((tx) => store.releaseExternalWriterIn(tx, 'missing', WRITER)),
      ).toBe(false);
    });

    test('keeps the mark when the release rolls back', async () => {
      const store = makeStore();
      await createMarked(store);
      await expect(
        inTransaction(async (tx) => {
          await store.releaseExternalWriterIn(tx, 'session-1', WRITER);
          throw new RollbackProbe();
        }),
      ).rejects.toBeInstanceOf(RollbackProbe);
      expect(await store.getSession('session-1')).toMatchObject({ externalWriter: WRITER });
    });

    test('appends its writer turns to the stream and the entry tree', async () => {
      const store = makeStore();
      await createMarked(store);
      const appended = await inTransaction((tx) =>
        store.appendExternalTurnIn(tx, 'session-1', WRITER, {
          events: [
            {
              ts: 1,
              type: AGENT_SESSION_LIFECYCLE.userMessage,
              data: { text: 'Teach photosynthesis' },
            },
            { ts: 2, type: 'tool_execution_end', data: { toolCallId: 'call-1' } },
          ],
          entries: [
            {
              id: 'user-1',
              parentId: null,
              type: 'message',
              timestamp: '2026-10-20T00:00:00.000Z',
              message: { role: 'user', content: 'Teach photosynthesis' },
            },
            {
              id: 'assistant-1',
              parentId: 'user-1',
              type: 'message',
              timestamp: '2026-10-20T00:00:01.000Z',
              message: { role: 'assistant', content: [] },
            },
          ],
        }),
      );
      expect(appended).toEqual({ eventSeqs: [1, 2] });
      expect(await store.readEventsAfter('session-1', 0)).toEqual([
        expect.objectContaining({ id: 1, attempt: 0, type: AGENT_SESSION_LIFECYCLE.userMessage }),
        expect.objectContaining({ id: 2, attempt: 0, type: 'tool_execution_end' }),
      ]);
      const tree = await store.openEntryTree('session-1', 'reader', 0);
      expect((await tree.getEntries()).map((entry) => entry.id)).toEqual(['user-1', 'assistant-1']);
      expect(await tree.getLeafId()).toBe('assistant-1');
      // The opening message is in the transcript the writer appended: a later
      // run must not deliver it a second time.
      expect(await store.getSession('session-1')).toMatchObject({ deliveredUserMessageSeq: 1 });

      const next = await inTransaction((tx) =>
        store.appendExternalTurnIn(tx, 'session-1', WRITER, {
          events: [{ ts: 3, type: 'tool_execution_end', data: { toolCallId: 'call-2' } }],
        }),
      );
      expect(next).toEqual({ eventSeqs: [3] });
      expect(await store.getSession('session-1')).toMatchObject({ deliveredUserMessageSeq: 1 });
    });

    test('rolls an appended turn back with the caller', async () => {
      const store = makeStore();
      await createMarked(store);
      await expect(
        inTransaction(async (tx) => {
          await store.appendExternalTurnIn(tx, 'session-1', WRITER, {
            events: [{ ts: 1, type: AGENT_SESSION_LIFECYCLE.userMessage, data: { text: 'x' } }],
            entries: [
              {
                id: 'user-1',
                parentId: null,
                type: 'message',
                timestamp: '2026-10-20T00:00:00.000Z',
                message: { role: 'user', content: 'x' },
              },
            ],
          });
          throw new RollbackProbe();
        }),
      ).rejects.toBeInstanceOf(RollbackProbe);
      expect(await store.lastEventSeq('session-1')).toBe(0);
      const tree = await store.openEntryTree('session-1', 'reader', 0);
      expect(await tree.getEntries()).toEqual([]);
      expect(await store.getSession('session-1')).toMatchObject({ deliveredUserMessageSeq: 0 });
    });

    test('refuses turns from another writer, an unmarked or a released session', async () => {
      const store = makeStore();
      await createMarked(store);
      const turn = { events: [{ ts: 1, type: 'tool_execution_end', data: null }] };
      await expect(
        inTransaction((tx) => store.appendExternalTurnIn(tx, 'session-1', 'other', turn)),
      ).rejects.toEqual(new AgentSessionExternalWriterError('session-1', WRITER));
      await store.createSession(makeAgentSessionInput({ id: 'session-2' }));
      await expect(
        inTransaction((tx) => store.appendExternalTurnIn(tx, 'session-2', WRITER, turn)),
      ).rejects.toEqual(new AgentSessionExternalWriterError('session-2', null));
      await expect(
        inTransaction((tx) => store.appendExternalTurnIn(tx, 'missing', WRITER, turn)),
      ).rejects.toBeInstanceOf(AgentSessionExternalWriterError);
      await inTransaction((tx) => store.releaseExternalWriterIn(tx, 'session-1', WRITER));
      await expect(
        inTransaction((tx) => store.appendExternalTurnIn(tx, 'session-1', WRITER, turn)),
      ).rejects.toBeInstanceOf(AgentSessionExternalWriterError);
      expect(await store.lastEventSeq('session-1')).toBe(0);
    });

    test('rejects a malformed entry before writing anything', async () => {
      const store = makeStore();
      await createMarked(store);
      await expect(
        inTransaction((tx) =>
          store.appendExternalTurnIn(tx, 'session-1', WRITER, {
            events: [{ ts: 1, type: 'tool_execution_end', data: null }],
            entries: [{ id: '', parentId: null, type: 'message', timestamp: 'never' }],
          }),
        ),
      ).rejects.toThrow(/entry identity, type, or timestamp is invalid/);
      expect(await store.lastEventSeq('session-1')).toBe(0);
    });

    describe('entries without a parentId attach to the current leaf', () => {
      const at = (second: number) => `2026-10-20T00:00:${String(second).padStart(2, '0')}.000Z`;
      const message = (id: string, second: number, parentId?: string | null) => ({
        id,
        ...(parentId === undefined ? {} : { parentId }),
        type: 'message',
        timestamp: at(second),
        message: { role: 'assistant', content: id },
      });
      const append = (
        store: AgentSessionExternalWriterContractStore,
        entries: Parameters<AgentSessionExternalWriterStore['appendExternalTurnIn']>[3]['entries'],
        tx?: AgentSessionTransaction,
      ) =>
        tx
          ? store.appendExternalTurnIn(tx, 'session-1', WRITER, { entries })
          : inTransaction((t) => store.appendExternalTurnIn(t, 'session-1', WRITER, { entries }));
      const parents = async (store: AgentSessionExternalWriterContractStore) => {
        const tree = await store.openEntryTree('session-1', 'reader', 0);
        return {
          entries: (await tree.getEntries()).map((entry) => [entry.id, entry.parentId]),
          leaf: await tree.getLeafId(),
        };
      };

      test('the first omitted parent of an empty tree is a root', async () => {
        const store = makeStore();
        await createMarked(store);
        await append(store, [message('a', 1)]);
        expect(await parents(store)).toEqual({ entries: [['a', null]], leaf: 'a' });
      });

      test('a batch chains entry after entry, and a later call continues it', async () => {
        const store = makeStore();
        await createMarked(store);
        await append(store, [message('a', 1), message('b', 2), message('c', 3)]);
        await append(store, [message('d', 4)]);
        expect(await parents(store)).toEqual({
          entries: [
            ['a', null],
            ['b', 'a'],
            ['c', 'b'],
            ['d', 'c'],
          ],
          leaf: 'd',
        });
      });

      test('an explicit null is still a root and an explicit id is still its parent', async () => {
        const store = makeStore();
        await createMarked(store);
        await append(store, [message('a', 1), message('b', 2)]);
        await append(store, [message('root-2', 3, null), message('x', 4), message('y', 5, 'a')]);
        await append(store, [message('z', 6)]);
        expect(await parents(store)).toEqual({
          entries: [
            ['a', null],
            ['b', 'a'],
            ['root-2', null],
            ['x', 'root-2'],
            ['y', 'a'],
            ['z', 'y'],
          ],
          leaf: 'z',
        });
      });

      test('follows a leaf marker to its target, in a batch and across calls', async () => {
        const store = makeStore();
        await createMarked(store);
        await append(store, [
          message('u', 1),
          message('v', 2),
          { id: 'cursor', type: 'leaf', timestamp: at(3), targetId: 'u' },
          message('w', 4),
        ]);
        await append(store, [{ id: 'cursor-2', type: 'leaf', timestamp: at(5), targetId: 'v' }]);
        await append(store, [message('x', 6)]);
        expect(await parents(store)).toEqual({
          entries: [
            ['u', null],
            ['v', 'u'],
            ['cursor', 'v'],
            ['w', 'u'],
            ['cursor-2', 'w'],
            ['x', 'v'],
          ],
          leaf: 'x',
        });
      });

      test('a leaf marker that targets null makes the next omitted parent a root', async () => {
        const store = makeStore();
        await createMarked(store);
        await append(store, [
          message('a', 1),
          { id: 'reset', type: 'leaf', timestamp: at(2), targetId: null },
        ]);
        await append(store, [message('b', 3)]);
        expect(await parents(store)).toEqual({
          entries: [
            ['a', null],
            ['reset', 'a'],
            ['b', null],
          ],
          leaf: 'b',
        });
      });

      test('a later call in the same transaction sees the entries it appended', async () => {
        const store = makeStore();
        await createMarked(store);
        await inTransaction(async (tx) => {
          await append(store, [message('a', 1)], tx);
          await append(store, [message('b', 2)], tx);
        });
        expect(await parents(store)).toEqual({
          entries: [
            ['a', null],
            ['b', 'a'],
          ],
          leaf: 'b',
        });
      });

      test('a rolled-back turn leaves the leaf where it was', async () => {
        const store = makeStore();
        await createMarked(store);
        await append(store, [message('a', 1)]);
        await expect(
          inTransaction(async (tx) => {
            await append(store, [message('b', 2), message('c', 3)], tx);
            throw new RollbackProbe();
          }),
        ).rejects.toBeInstanceOf(RollbackProbe);
        await append(store, [message('d', 4)]);
        expect(await parents(store)).toEqual({
          entries: [
            ['a', null],
            ['d', 'a'],
          ],
          leaf: 'd',
        });
      });
    });
  });
}
