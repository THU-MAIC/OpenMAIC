/**
 * Process-wide LISTEN/NOTIFY wakeup bus for the agent runtime's SSE tails and
 * per-session runner loop.
 *
 * Ported from the reference implementation with the storage seam substituted:
 * the reference notifies through a drizzle transaction handle (`db.execute`),
 * this port notifies through the storage package's transaction surface
 * (`query(text, params)`). Everything else — channel names, payload routes,
 * the self-check probe, reconnect/backoff, the in-process fanout registry —
 * is kept byte-identical so a session stream wakes within ~100ms of a durable
 * event append instead of waiting for the fallback poll.
 *
 * The durable event log stays the single source of truth: NOTIFY is
 * deliberately only a LOSSY wakeup. A notification dropped by a proxy, a
 * parameter group, or a listener disconnect degrades only latency — every
 * SSE route and the runner keep their fallback polls and converge anyway.
 */
import { Client, type Notification } from 'pg';

import { createLogger } from '@/lib/logger';

/** The minimal query surface a transaction handle must expose for pg_notify. */
export interface NotifyQueryable {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: TRow[] }>;
}
type NotifyDb = Pick<NotifyQueryable, 'query'>;

export const AGENT_EVENT_NOTIFY_CHANNEL = 'openmaic_agent_event_wakeup';
/**
 * Dedicated self-check channel. The probe notification travels on its own
 * channel so the fanout path (keyed on AGENT_EVENT_NOTIFY_CHANNEL) can never
 * mistake it for a business wakeup — a probe can never fake-wake a stream.
 * Exported because the PG contract tests fault-inject the delivery path and
 * need the channel name to identify probe notifications.
 */
export const AGENT_EVENT_PROBE_CHANNEL = 'openmaic_agent_event_selfcheck';
export const AGENT_EVENT_NOTIFY_APPLICATION_NAME = 'openmaic-agent-notify-bus';

export type AgentEventWakeupRoute =
  | { kind: 'owner'; ownerId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'stage'; stageId: string };

type Subscriber = () => void;

type ProbeResult = 'received' | 'timeout' | 'cancelled';

interface PendingProbe {
  client: Client;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
  finish: (result: ProbeResult) => void;
}

interface BusState {
  client: Client | null;
  connecting: Promise<void> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  reconnectDelayMs: number;
  hasConnected: boolean;
  stopped: boolean;
  generation: number;
  subscribers: Map<string, Set<Subscriber>>;
  /** In-flight self-check probe, armed right after every successful (re)LISTEN. */
  pendingProbe: PendingProbe | null;
}

export interface AgentEventNotifyBusHandle {
  stop: () => Promise<void>;
  /**
   * Resolves when the initial LISTEN attempt has settled — connected, or
   * failed with a retry scheduled. Exposing it makes connection establishment
   * observable, so tests can await it instead of racing the count.
   */
  connecting: Promise<void>;
}

const log = createLogger('AgentEventNotifyBus');
const GLOBAL_KEY = '__openmaicAgentEventNotifyBus';
const globalWithBus = globalThis as typeof globalThis & { [GLOBAL_KEY]?: BusState };

function createState(): BusState {
  return {
    client: null,
    connecting: null,
    retryTimer: null,
    reconnectDelayMs: 100,
    hasConnected: false,
    stopped: true,
    generation: 0,
    subscribers: new Map(),
    pendingProbe: null,
  };
}

const state = (globalWithBus[GLOBAL_KEY] ??= createState());

function routeKey(route: AgentEventWakeupRoute): string {
  switch (route.kind) {
    case 'owner':
      return `owner:${route.ownerId}`;
    case 'session':
      return `session:${route.sessionId}`;
    case 'stage':
      return `stage:${route.stageId}`;
  }
}

function parseRoute(notification: Notification): AgentEventWakeupRoute | null {
  if (notification.channel !== AGENT_EVENT_NOTIFY_CHANNEL || !notification.payload) return null;
  try {
    const value = JSON.parse(notification.payload) as Partial<AgentEventWakeupRoute>;
    if (value.kind === 'owner' && typeof value.ownerId === 'string' && value.ownerId) {
      return { kind: 'owner', ownerId: value.ownerId };
    }
    if (value.kind === 'session' && typeof value.sessionId === 'string' && value.sessionId) {
      return { kind: 'session', sessionId: value.sessionId };
    }
    if (value.kind === 'stage' && typeof value.stageId === 'string' && value.stageId) {
      return { kind: 'stage', stageId: value.stageId };
    }
  } catch {
    // A malformed or foreign payload is unrelated to this process's streams.
  }
  return null;
}

function fanout(subscribers: Iterable<Subscriber>) {
  for (const wake of [...subscribers]) {
    try {
      wake();
    } catch (error) {
      log.error('subscriber wakeup failed', error);
    }
  }
}

function fanoutAll() {
  for (const subscribers of state.subscribers.values()) fanout(subscribers);
}

/** How long the self-check waits for the probe notification to come back. */
const AGENT_EVENT_PROBE_TIMEOUT_MS = 2_000;
const AGENT_EVENT_PROBE_PAYLOAD = 'openmaic-agent-notify-selfcheck';

/**
 * Self-check that LISTEN/NOTIFY actually round-trips on this connection.
 *
 * Sends a probe NOTIFY on the dedicated probe channel from the bus's own
 * client — PostgreSQL delivers NOTIFY back to a listening session, so an
 * arrival proves the wakeup channel is live end-to-end (LISTEN side and
 * NOTIFY side) for this process. Without this, a silently dead wakeup
 * channel — a transaction-pooling proxy such as PgBouncer in front of PG, a
 * parameter group disabling NOTIFY delivery, the channel name taken over by
 * another service — would only surface as SSE latency regressing from ~100ms
 * to the fallback polling interval: no error, no log, looking healthy. That
 * is exactly the silent degradation this probe exists to make observable.
 *
 * Failure is deliberately non-fatal: no throw, no retry storm, no blocking of
 * the bus. The fallback poll stays the correctness backstop, so a probe
 * timeout only degrades latency, never correctness.
 */
async function runProbe(client: Client, generation: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = (result: ProbeResult) => {
      const pending = state.pendingProbe;
      if (pending && pending.client === client && pending.generation === generation) {
        clearTimeout(pending.timer);
        state.pendingProbe = null;
        if (result === 'received') {
          log.debug('agent event LISTEN/NOTIFY self-check passed');
        } else if (result === 'timeout') {
          log.warn(
            'agent event LISTEN/NOTIFY self-check FAILED: the probe notification was sent on ' +
              `channel ${AGENT_EVENT_PROBE_CHANNEL} but never came back within ${AGENT_EVENT_PROBE_TIMEOUT_MS}ms. ` +
              'The wakeup channel is probably unusable even though the connection is up. ' +
              'Most likely causes: a transaction-pooling proxy such as PgBouncer in front of PostgreSQL ' +
              '(LISTEN/NOTIFY needs a session-level connection), a database parameter group disabling ' +
              'NOTIFY delivery, or the channel name being taken over by another service. ' +
              'Consequence: the SSE event streams silently degrade to the fallback polling intervals ' +
              '(owner 30s / session 5s / terminal 10s) — wakeup latency regresses from ~100ms to the ' +
              'fallback interval. Correctness is NOT affected: the durable log read stays the source of ' +
              'truth, so streams keep converging, just slower.',
          );
        }
      }
      resolve();
    };
    const timer = setTimeout(() => finish('timeout'), AGENT_EVENT_PROBE_TIMEOUT_MS);
    timer.unref?.();
    state.pendingProbe = { client, generation, timer, finish };
    // Send from this same connection. If the query itself fails the
    // connection is already going down — the disconnect handler logs that,
    // so settle as 'cancelled' and keep the warn for the case that matters:
    // connection alive, notification never delivered.
    void client
      .query(`SELECT pg_notify($1, $2)`, [AGENT_EVENT_PROBE_CHANNEL, AGENT_EVENT_PROBE_PAYLOAD])
      .catch(() => finish('cancelled'));
  });
}

/** Drop a stale probe without logging: the connection is going away anyway. */
function cancelPendingProbe(client: Client | null, generation: number) {
  const pending = state.pendingProbe;
  if (!pending || pending.client !== client || pending.generation !== generation) return;
  clearTimeout(pending.timer);
  state.pendingProbe = null;
  pending.finish('cancelled');
}

function scheduleReconnect() {
  if (state.stopped || state.retryTimer) return;
  const delay = state.reconnectDelayMs;
  state.reconnectDelayMs = Math.min(delay * 2, 5_000);
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    void ensureConnected();
  }, delay);
  state.retryTimer.unref?.();
}

function disconnected(client: Client, generation: number, error?: unknown) {
  if (generation !== state.generation || state.client !== client) return;
  state.client = null;
  state.connecting = null;
  cancelPendingProbe(client, generation);
  if (error) log.error('dedicated LISTEN connection lost; retrying', error);
  scheduleReconnect();
}

async function connect(generation: number): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required for agent event LISTEN');
  }

  // LISTEN is connection-scoped, so this must be a dedicated Client. It must
  // never come from getPool() and must never be created per SSE stream. The
  // process-wide state above gives one application instance exactly one live
  // LISTEN connection and fans notifications out in memory.
  const client = new Client({
    connectionString,
    application_name: AGENT_EVENT_NOTIFY_APPLICATION_NAME,
    connectionTimeoutMillis: 10_000,
  });
  state.client = client;
  client.on('notification', (notification) => {
    if (notification.channel === AGENT_EVENT_PROBE_CHANNEL) {
      // Self-check probe: our own diagnostic notification, never a wakeup
      // route. Resolve the pending probe and stop here — it must never reach
      // the fanout registry below, or a probe would fake-wake every stream.
      const pending = state.pendingProbe;
      if (pending && pending.client === client && pending.generation === generation) {
        pending.finish('received');
      }
      return;
    }
    const route = parseRoute(notification);
    if (!route) return;
    const subscribers = state.subscribers.get(routeKey(route));
    if (subscribers) fanout(subscribers);
  });
  client.on('error', (error) => disconnected(client, generation, error));
  client.on('end', () => disconnected(client, generation));

  try {
    await client.connect();
    if (state.stopped || generation !== state.generation) {
      await client.end().catch(() => undefined);
      return;
    }
    await client.query(`LISTEN ${AGENT_EVENT_NOTIFY_CHANNEL}`);
    if (state.stopped || generation !== state.generation) {
      await client.end().catch(() => undefined);
      return;
    }
    // The self-check channel is auxiliary diagnostics. If a proxy or
    // parameter group refuses it, the business LISTEN above still works —
    // never let the probe take the connection down with it. Without the
    // channel there is no round trip to measure, so skip the probe.
    let probeChannelListened = true;
    try {
      await client.query(`LISTEN ${AGENT_EVENT_PROBE_CHANNEL}`);
    } catch {
      probeChannelListened = false;
    }
    if (state.stopped || generation !== state.generation) {
      await client.end().catch(() => undefined);
      return;
    }
    state.reconnectDelayMs = 100;
    const reconnected = state.hasConnected;
    state.hasConnected = true;
    // NOTIFY is not persistent: every signal sent while this client was down
    // was simply lost. A successful re-LISTEN therefore wakes every local
    // stream once so its durable `id > cursor` read closes that loss window.
    if (reconnected) fanoutAll();
    // Startup (and every reconnect) self-check: prove the wakeup channel is
    // usable before we silently rely on it. Only a warn on failure — never a
    // throw, never a retry, and the notification handler is already live, so
    // business wakeups are not delayed by the probe.
    if (probeChannelListened) await runProbe(client, generation);
  } catch (error) {
    disconnected(client, generation, error);
    await client.end().catch(() => undefined);
    throw error;
  }
}

async function ensureConnected(): Promise<void> {
  if (state.stopped || state.client || state.connecting) return state.connecting ?? undefined;
  const generation = ++state.generation;
  state.connecting = connect(generation)
    .catch(() => {
      scheduleReconnect();
    })
    .finally(() => {
      if (generation === state.generation) state.connecting = null;
    });
  return state.connecting;
}

export function startAgentEventNotifyBus(): AgentEventNotifyBusHandle {
  state.stopped = false;
  const connecting = ensureConnected();
  return { stop: stopAgentEventNotifyBus, connecting };
}

export async function stopAgentEventNotifyBus(): Promise<void> {
  state.stopped = true;
  state.generation += 1;
  if (state.retryTimer) clearTimeout(state.retryTimer);
  state.retryTimer = null;
  state.connecting = null;
  const client = state.client;
  state.client = null;
  state.hasConnected = false;
  state.reconnectDelayMs = 100;
  // generation already advanced above, so cancel the probe directly.
  const pending = state.pendingProbe;
  if (pending) {
    clearTimeout(pending.timer);
    state.pendingProbe = null;
    pending.finish('cancelled');
  }
  if (client) await client.end().catch(() => undefined);
}

/**
 * Whether any local subscriber is currently registered for a route.
 *
 * Diagnostic/test hook: pins subscription lifecycle (a leaked subscription
 * would keep a finished session's entry in the registry and grow with every
 * run), which the PG contract tests assert on.
 */
export function hasAgentEventWakeupSubscriber(route: AgentEventWakeupRoute): boolean {
  const subscribers = state.subscribers.get(routeKey(route));
  return subscribers ? subscribers.size > 0 : false;
}

export function subscribeAgentEventWakeup(
  route: AgentEventWakeupRoute,
  wake: Subscriber,
): () => void {
  const key = routeKey(route);
  let subscribers = state.subscribers.get(key);
  if (!subscribers) {
    subscribers = new Set();
    state.subscribers.set(key, subscribers);
  }
  subscribers.add(wake);
  startAgentEventNotifyBus();

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscribers?.delete(wake);
    if (subscribers?.size === 0) state.subscribers.delete(key);
  };
}

function payload(route: AgentEventWakeupRoute): string {
  return JSON.stringify(route);
}

/** PostgreSQL's hard limit on pg_notify payloads. */
const PG_NOTIFY_PAYLOAD_MAX_BYTES = 8000;

/**
 * Queue a wakeup in the SAME transaction as a durable event append.
 *
 * NOTIFY is deliberately only a lossy wakeup, never the data channel: it is
 * not persisted while listeners are disconnected and its payload is limited
 * to 8000 bytes. Consumers always re-read the durable `id > cursor` log.
 * PostgreSQL delivers this only at commit and folds identical channel+payload
 * NOTIFY calls within one transaction, naturally coalescing event bursts.
 *
 * Volatile signals (no event row, no owner counter slot) reuse this same
 * channel with the same payload route — same lossy semantics. There is
 * intentionally no separate API for them until a real consumer exists.
 */
export async function notifyDurableAgentEvent(
  db: NotifyDb,
  route: AgentEventWakeupRoute,
): Promise<void> {
  const message = payload(route);
  // pg_notify errors out above 8000 bytes. Because this runs INSIDE the
  // caller's transaction, such an error would poison the transaction and take
  // the durable event INSERT down with it — a derived projection must never
  // be able to fail the primary write. NOTIFY is lossy by design, so skipping
  // the notification is safe: the reader's fallback poll still converges.
  // This must be a PRE-SEND length check: once PG raises inside the
  // transaction, the transaction is aborted and no JS catch can save it.
  if (Buffer.byteLength(message, 'utf8') > PG_NOTIFY_PAYLOAD_MAX_BYTES) {
    log.warn('agent event notify payload exceeds pg_notify limit; notification skipped', {
      bytes: Buffer.byteLength(message, 'utf8'),
      limit: PG_NOTIFY_PAYLOAD_MAX_BYTES,
      kind: route.kind,
    });
    return;
  }
  await db.query('SELECT pg_notify($1, $2)', [AGENT_EVENT_NOTIFY_CHANNEL, message]);
}
