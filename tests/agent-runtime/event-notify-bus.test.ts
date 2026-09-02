/**
 * Agent event LISTEN/NOTIFY bus — hermetic unit test with a fake `pg.Client`.
 *
 * The bus's PG contract (real LISTEN/NOTIFY round-trip, reconnect fanout,
 * probe self-check) is covered by the `.pg.test.ts` suite when
 * PG_CONTRACT_URL is set; this suite pins the parts that are pure JS:
 *
 *  1. the wakeup payload route (session/owner) reaches the right subscriber
 *     and never leaks into another route;
 *  2. the self-check probe channel can never fake-wake a subscriber;
 *  3. `notifyDurableAgentEvent` queues `SELECT pg_notify` on the caller's
 *     transaction handle (same-transaction lossy wakeup) and silently skips
 *     an over-limit payload instead of poisoning the transaction;
 *  4. subscription lifecycle: unsubscribe removes the route from the
 *     registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Notification as PgNotification } from 'pg';

const fake = vi.hoisted(() => {
  type Listener = (value?: unknown) => void;
  class FakeClient {
    static instances: FakeClient[] = [];
    queryCalls: Array<{ text: string; params: unknown[] }> = [];
    private listeners = new Map<string, Set<Listener>>();
    ended = false;

    constructor(_config?: unknown) {
      FakeClient.instances.push(this);
    }

    async connect(): Promise<void> {
      // no-op
    }

    async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
      this.queryCalls.push({ text, params });
      return { rows: [] };
    }

    async end(): Promise<void> {
      this.ended = true;
    }

    on(event: string, listener: Listener): this {
      let set = this.listeners.get(event);
      if (!set) {
        set = new Set();
        this.listeners.set(event, set);
      }
      set.add(listener);
      return this;
    }

    /** Test hook: deliver a PostgreSQL notification to the registered listeners. */
    emitNotification(channel: string, payload: string): void {
      const notification = { channel, payload, processId: 1 } as PgNotification;
      for (const listener of this.listeners.get('notification') ?? []) listener(notification);
    }
  }
  return { FakeClient };
});

vi.mock('pg', () => ({ Client: fake.FakeClient }));

import {
  AGENT_EVENT_NOTIFY_CHANNEL,
  AGENT_EVENT_PROBE_CHANNEL,
  hasAgentEventWakeupSubscriber,
  notifyDurableAgentEvent,
  startAgentEventNotifyBus,
  stopAgentEventNotifyBus,
  subscribeAgentEventWakeup,
} from '@/lib/server/agent-runtime/event-notify-bus';

/** A transaction handle shaped like the storage package's AgentSessionTransaction. */
function txProbe() {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  return {
    calls,
    query: async <TRow extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ) => {
      calls.push({ text, params });
      return { rows: [] as TRow[] };
    },
  };
}

describe('agent event notify bus', () => {
  beforeEach(() => {
    fake.FakeClient.instances = [];
    // The bus builds its dedicated LISTEN client from DATABASE_URL (the app
    // contract); the fake client never connects anywhere, the variable just
    // has to be present for the bus to construct it.
    process.env.DATABASE_URL = 'postgres://fake:fake@localhost:5432/fake';
  });

  afterEach(async () => {
    delete process.env.DATABASE_URL;
    await stopAgentEventNotifyBus();
  });

  it('wakes exactly the subscribers of the route a notification names', async () => {
    const handle = startAgentEventNotifyBus();
    await handle.connecting;

    const sessionWake = vi.fn();
    const otherWake = vi.fn();
    const ownerWake = vi.fn();
    const unsubscribeSession = subscribeAgentEventWakeup(
      { kind: 'session', sessionId: 'session-1' },
      sessionWake,
    );
    const unsubscribeOther = subscribeAgentEventWakeup(
      { kind: 'session', sessionId: 'session-2' },
      otherWake,
    );
    const unsubscribeOwner = subscribeAgentEventWakeup(
      { kind: 'owner', ownerId: 'owner-a' },
      ownerWake,
    );

    expect(hasAgentEventWakeupSubscriber({ kind: 'session', sessionId: 'session-1' })).toBe(true);
    const client = fake.FakeClient.instances.at(-1)!;
    // The probe channel is also listened; complete the startup self-check so no
    // 2s probe timer lingers.
    client.emitNotification(AGENT_EVENT_PROBE_CHANNEL, 'openmaic-agent-notify-selfcheck');

    client.emitNotification(
      AGENT_EVENT_NOTIFY_CHANNEL,
      JSON.stringify({ kind: 'session', sessionId: 'session-1' }),
    );
    expect(sessionWake).toHaveBeenCalledOnce();
    expect(otherWake).not.toHaveBeenCalled();
    expect(ownerWake).not.toHaveBeenCalled();

    unsubscribeSession();
    expect(hasAgentEventWakeupSubscriber({ kind: 'session', sessionId: 'session-1' })).toBe(false);
    client.emitNotification(
      AGENT_EVENT_NOTIFY_CHANNEL,
      JSON.stringify({ kind: 'session', sessionId: 'session-1' }),
    );
    expect(sessionWake).toHaveBeenCalledOnce();

    client.emitNotification(
      AGENT_EVENT_NOTIFY_CHANNEL,
      JSON.stringify({ kind: 'owner', ownerId: 'owner-a' }),
    );
    expect(ownerWake).toHaveBeenCalledOnce();
    unsubscribeOther();
    unsubscribeOwner();
  });

  it('never treats a probe notification or a malformed payload as a wakeup', async () => {
    const handle = startAgentEventNotifyBus();
    await handle.connecting;
    const wake = vi.fn();
    const unsubscribe = subscribeAgentEventWakeup({ kind: 'session', sessionId: 's' }, wake);
    const client = fake.FakeClient.instances.at(-1)!;
    client.emitNotification(AGENT_EVENT_PROBE_CHANNEL, 'openmaic-agent-notify-selfcheck');
    expect(wake).not.toHaveBeenCalled();

    client.emitNotification(AGENT_EVENT_NOTIFY_CHANNEL, '{not json');
    expect(wake).not.toHaveBeenCalled();

    client.emitNotification(AGENT_EVENT_NOTIFY_CHANNEL, '{"kind":"session"}');
    expect(wake).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('queues a session-route pg_notify on the caller transaction and skips over-limit payloads', async () => {
    const tx = txProbe();
    await notifyDurableAgentEvent(tx, { kind: 'session', sessionId: 'session-1' });
    expect(tx.calls).toEqual([
      {
        text: 'SELECT pg_notify($1, $2)',
        params: [AGENT_EVENT_NOTIFY_CHANNEL, '{"kind":"session","sessionId":"session-1"}'],
      },
    ]);

    // An over-limit route payload is skipped BEFORE the query: once PG raises
    // inside a transaction the transaction is aborted and no JS catch can save
    // it, so the length check must be pre-send (reference semantics).
    const big = txProbe();
    await expect(
      notifyDurableAgentEvent(big, { kind: 'session', sessionId: 'x'.repeat(8_001) }),
    ).resolves.toBeUndefined();
    expect(big.calls).toEqual([]);
  });
});
