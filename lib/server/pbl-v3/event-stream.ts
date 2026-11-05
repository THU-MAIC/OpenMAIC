import 'server-only';
import { setTimeout as delay } from 'node:timers/promises';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import { subscribeAgentEventWakeup } from '@/lib/server/agent-runtime/event-notify-bus';
import {
  acquireRunStreamSlot,
  polledEventStream,
  sseFrame,
  sseHeaders,
} from '@/lib/server/generation/run/sse';
import { SandboxError } from '@/lib/sandbox/errors';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';
import { LearningStore } from './store';
import { learningView, type LearningObservation } from './runtime';
import { workbenchView } from './workbench';

const RECONCILE_MS = 25_000;
const EXECUTION_MS = 1_000;
const ACTIVE = new Set(['starting', 'running', 'unknown']);

/** A replacement snapshot on every attach also repairs gaps across reconnects. */
export async function learningEventResponse(
  principal: OwnerPrincipal,
  id: string,
  signal: AbortSignal,
): Promise<Response> {
  const store = await LearningStore.open();
  await store.get(id, principal.ownerId);
  const release = acquireRunStreamSlot(principal.ownerId);
  if (!release) throw new SandboxError('PBL_BUSY', 429, 'Too many learning streams are open.');
  const stop = new AbortController();
  const lifetime = AbortSignal.any([signal, stop.signal]);
  const subscriptions = new Map<string, () => void>();
  let wake: () => void = () => {};
  let closed = false;
  let observation: LearningObservation | undefined;
  let observedAt = 0;
  let checkedAt = 0;
  let executionPending = false;
  let work: LearningWorkbench | null = null;
  let workKey = '';
  let last = '';
  let confirmedAt = 0;
  const subscribe = (sessionIds: string[]) => {
    const wanted = new Set([id, ...sessionIds]);
    for (const [key, unsubscribe] of subscriptions) {
      if (!wanted.has(key)) {
        unsubscribe();
        subscriptions.delete(key);
      }
    }
    if (closed) return;
    for (const sessionId of wanted) {
      if (!subscriptions.has(sessionId))
        subscriptions.set(
          sessionId,
          subscribeAgentEventWakeup({ kind: 'session', sessionId }, () => {
            if (sessionId === id) observation = undefined;
            wake();
          }),
        );
    }
  };
  const body = polledEventStream({
    wakeup: { kind: 'session', sessionId: id },
    signal: lifetime,
    subscribe: (read) => {
      wake = read;
      subscribe([]);
      return () => {
        closed = true;
        for (const unsubscribe of subscriptions.values()) unsubscribe();
        subscriptions.clear();
      };
    },
    // Provider commands have no completion callback. Observe active execution
    // here; idle reconciliation also repairs lost NOTIFYs. Neither renews leases.
    pollIntervalMs: () => (executionPending ? EXECUTION_MS : RECONCILE_MS),
    onClose: release,
    read: async (write, phase) => {
      // Coalesce token bursts before rebuilding the bounded transcript. The
      // shared transport serializes reads and bounds the slow client's queue.
      if (phase === 'live') await delay(250, undefined, { signal: lifetime });
      if (closed) return;
      try {
        const row = await store.get(id, principal.ownerId);
        if (closed) return;
        const roles = await store.roles(id);
        if (closed) return;
        subscribe(roles.map((role) => role.session_id));
        const now = Date.now();
        const checkHealth = !observation || now - checkedAt >= RECONCILE_MS;
        const observe =
          checkHealth ||
          !observation ||
          observation.revision !== row.revision ||
          observation.environmentId !== row.environment_id ||
          now - observedAt >= (executionPending ? EXECUTION_MS : RECONCILE_MS);
        const view = await learningView(principal, id, {
          passive: true,
          checkHealth,
          ...(observe ? {} : { observation }),
        });
        if (closed) return;
        if (observe) {
          observation = view;
          observedAt = now;
          if (checkHealth) checkedAt = now;
        }
        const key = `${view.environmentId}:${view.revision}:${view.busy}:${view.environment?.ready}`;
        if (!view.environment?.ready) {
          work = null;
          workKey = '';
        } else if (workKey !== key || observe) {
          work = await workbenchView(principal, id, { passive: true });
          workKey = key;
        }
        if (closed) return;
        executionPending =
          !!row.evaluation || !!work?.commands.some((cmd) => ACTIVE.has(cmd.state));
        const frame = sseFrame('learning', { view, workbench: work });
        // Never advance the replacement cursor when backpressure rejects a frame.
        if (frame !== last) {
          if (write(frame)) {
            last = frame;
            confirmedAt = Date.now();
          }
        } else if (Date.now() - confirmedAt >= RECONCILE_MS) {
          // Confirm a successful projection, not just a live transport heartbeat.
          if (write(sseFrame('observed', { id }))) confirmedAt = Date.now();
        }
      } catch (error) {
        if (closed) return;
        if (error instanceof SandboxError && error.status === 404) {
          write(sseFrame('unavailable', {}));
          stop.abort();
          return;
        }
        // A failed observation must not leave stale permissions on screen.
        // Close through the normal reconnect path without exposing SDK errors.
        write(sseFrame('retry', {}));
        stop.abort();
      }
    },
  });
  return new Response(body, { headers: sseHeaders(new Headers({ 'x-accel-buffering': 'no' })) });
}
