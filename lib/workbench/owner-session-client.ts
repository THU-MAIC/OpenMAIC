import {
  newestFirst,
  reduceOwnerSessionEvent,
  reduceOwnerStreamSignal,
  type OwnerSessionEvent,
  type OwnerStreamState,
  type ProHomeSessionItem,
} from '@/lib/workbench/pro-home-data';

// This is a closed set because EventSource dispatches named events only to
// matching listeners; future server event names are structurally invisible
// here and are recovered by the 60-75 second full reconciliation.
export const OWNER_SESSION_EVENT_TYPES = [
  'session_created',
  'session_status',
  'session_deleted',
  'session_active_stage',
  'session_cancel_requested',
  'session_title',
] as const;

export const SESSION_RECONCILE_MIN_MS = 60_000;
export const SESSION_RECONCILE_JITTER_MS = 15_000;
export const STREAM_HEALTH_SAMPLE_MS = 5_000;
/**
 * Consecutive CONNECTING samples before the push channel is reported unhealthy
 * (9 x 5s = 45s, comfortably past the server's 25s heartbeat).
 *
 * Counted in SAMPLES, not wall-clock elapsed: a suspended tab freezes the
 * interval but not the clock, so a wall-clock threshold reports a dead stream
 * on wake for a connection that is reconnecting normally. No samples fire while
 * frozen, so a count cannot be inflated by suspension.
 */
export const STREAM_CONNECTING_SAMPLE_LIMIT = 9;
export const OWNER_SESSION_JOURNAL_LIMIT = 1_024;
export const MALFORMED_EVENT_RECONCILE_THRESHOLD = 5;

type SessionListState = 'loading' | 'ready' | 'error';

export interface OwnerEventSource {
  readonly readyState: number;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
}

export interface OwnerEventSourceInit {
  readonly headers?: Readonly<Record<string, string>>;
}

interface OwnerSessionClientOptions {
  readonly fetchSessions: () => Promise<ProHomeSessionItem[]>;
  readonly createEventSource: (url: string, init?: OwnerEventSourceInit) => OwnerEventSource;
  readonly onSessions: (
    sessions: readonly ProHomeSessionItem[],
    source?: 'incremental' | 'snapshot',
  ) => void;
  readonly onSessionTitle?: (sessionId: string, title: string | null) => void;
  readonly onState: (state: SessionListState) => void;
  readonly onInitialized?: () => void;
  /**
   * Push-channel liveness, reported separately from the list state on purpose.
   * Correctness comes from the pull path: a dead stream only costs latency
   * (at most one 60-75s reconciliation), so it must NOT be surfaced as a list
   * error -- the rail only renders its error state on an empty list, where a
   * "failed to load" message plus a retry button that cannot clear it is worse
   * than no signal. Surfacing this to the user needs its own indicator, which
   * is a UI decision left out of this PR; nothing consumes it yet.
   */
  readonly onStreamHealth?: (healthy: boolean) => void;
  readonly random?: () => number;
}

function isDecimalCursor(value: unknown): value is string {
  // Event ids deliberately reject leading zeroes. compareDecimalCursor is a
  // more permissive standalone helper and normalizes them before comparison.
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

/** Compare non-negative decimal integers without converting them to Number. */
export function compareDecimalCursor(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '');
  const normalizedRight = right.replace(/^0+(?=\d)/, '');
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1;
}

function parseData(event: Event): unknown {
  try {
    return JSON.parse((event as MessageEvent).data as string) as unknown;
  } catch {
    return null;
  }
}

function isOwnerSessionEvent(value: unknown): value is OwnerSessionEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  const validBase =
    typeof event.type === 'string' &&
    (OWNER_SESSION_EVENT_TYPES as readonly string[]).includes(event.type) &&
    isDecimalCursor(event.id) &&
    typeof event.sessionId === 'string' &&
    typeof event.ts === 'number';
  if (!validBase) return false;
  return event.type !== 'session_title' || event.title === null || typeof event.title === 'string';
}

/**
 * Owns the owner-level session stream and its low-frequency full calibration.
 * Data shaping remains in pro-home-data; this class only coordinates IO,
 * cursor-safe snapshot replay, coalescing and EventSource lifecycle.
 *
 * The 60-75 second full reconciliation owns data correctness, so a dead stream
 * can delay data by at most one reconciliation cycle. The readyState probe is
 * only a liveness signal that tells the UI when the push channel is degraded.
 */
export class OwnerSessionClient {
  private sessions: readonly ProHomeSessionItem[] = [];
  private cursor = '0';
  private journal: OwnerSessionEvent[] = [];
  private streamState: OwnerStreamState = { initialized: false, degraded: false };
  private source: OwnerEventSource | null = null;
  private epoch = 0;
  private stopped = true;
  private requestInFlight = false;
  private requestPending = false;
  private lastFullFetchFailed = false;
  private malformedEventCount = 0;
  private connectingSamples = 0;
  private streamDegraded = false;
  private titleMutationRevision = 0;
  private titleMutations = new Map<
    string,
    { readonly revision: number; readonly title: string | null; readonly settled: boolean }
  >();
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private streamHealthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: OwnerSessionClientOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.openStream();
    this.requestFullFetch(true);
    this.scheduleReconciliation();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.epoch += 1;
    this.source?.close();
    this.source = null;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
    if (this.streamHealthTimer) clearInterval(this.streamHealthTimer);
    this.streamHealthTimer = null;
    this.cursor = '0';
    this.journal = [];
    this.lastFullFetchFailed = false;
    this.malformedEventCount = 0;
    this.connectingSamples = 0;
    this.streamDegraded = false;
    this.titleMutationRevision = 0;
    this.titleMutations.clear();
  }

  requestFullFetch(showLoading = false): void {
    if (this.stopped) return;
    if (showLoading) this.options.onState('loading');
    if (this.requestInFlight) {
      this.requestPending = true;
      return;
    }
    this.runFullFetch();
  }

  updateSessions(
    update: (sessions: readonly ProHomeSessionItem[]) => readonly ProHomeSessionItem[],
  ): void {
    const next = update(this.sessions);
    if (next === this.sessions) return;
    this.sessions = next;
    this.options.onSessions(next);
  }

  /** A local title decision retained until a post-settlement snapshot confirms it. */
  updateSessionTitle(sessionId: string, title: string | null, settled: boolean): number {
    const revision = (this.titleMutationRevision += 1);
    this.titleMutations.set(sessionId, {
      revision,
      title,
      settled,
    });
    this.updateSessions((sessions) =>
      sessions.map((session) => (session.id === sessionId ? { ...session, title } : session)),
    );
    return revision;
  }

  isSessionTitleRevisionCurrent(sessionId: string, revision: number): boolean {
    return this.titleMutations.get(sessionId)?.revision === revision;
  }

  /**
   * The local title decision a full owner snapshot has not confirmed yet.
   * The wrapper is intentional: `null` is a real decision (clear the manual
   * title), while a null return means this client has no decision to preserve.
   */
  getUnconfirmedSessionTitle(sessionId: string): { readonly title: string | null } | null {
    const mutation = this.titleMutations.get(sessionId);
    return mutation ? { title: mutation.title } : null;
  }

  private openStream(): void {
    const epoch = this.epoch;
    const source = this.options.createEventSource('/api/agent/owner-events', { headers: {} });
    this.source = source;
    this.connectingSamples = 0;
    if (this.streamHealthTimer) clearInterval(this.streamHealthTimer);
    this.streamHealthTimer = setInterval(
      () => this.observeStreamHealth(source, epoch),
      STREAM_HEALTH_SAMPLE_MS,
    );

    const onSessionEvent = (raw: Event) => {
      if (this.stopped || epoch !== this.epoch) return;
      const event = parseData(raw);
      if (!isOwnerSessionEvent(event)) {
        this.malformedEventCount += 1;
        if (this.malformedEventCount >= MALFORMED_EVENT_RECONCILE_THRESHOLD) {
          this.malformedEventCount = 0;
          this.requestFullFetch();
        }
        return;
      }
      this.malformedEventCount = 0;
      this.cursor = event.id;
      const reduced = reduceOwnerSessionEvent(this.sessions, event);
      // PATCH responses and owner events travel independently. Until a read
      // confirms the write, no event can safely retire its local decision.
      const unconfirmedTitleMutation =
        event.type === 'session_title' && this.titleMutations.has(event.sessionId);
      const timestampStaleTitle =
        event.type === 'session_title' &&
        !reduced.needsFullFetch &&
        reduced.sessions === this.sessions;
      // `updatedAt` also contains app-clock lifecycle writes, so a small clock
      // skew can make a committed DB-clock title look old. A fresh list read
      // distinguishes that case from a genuinely stale projection. A title
      // hidden by a retained local decision likewise needs a read after the
      // current one: if that read fails, the received event must not remain
      // hidden until the minute-scale periodic reconciliation.
      if (timestampStaleTitle || unconfirmedTitleMutation) this.requestFullFetch();
      if (!timestampStaleTitle) {
        this.journal.push(event);
        if (this.journal.length > OWNER_SESSION_JOURNAL_LIMIT) {
          this.journal.splice(0, this.journal.length - OWNER_SESSION_JOURNAL_LIMIT);
          this.requestFullFetch();
        }
        if (event.type === 'session_title' && !unconfirmedTitleMutation) {
          this.titleMutations.delete(event.sessionId);
          this.options.onSessionTitle?.(event.sessionId, event.title);
        }
      }
      const nextSessions = this.overlaySessionTitleMutations(reduced.sessions);
      if (nextSessions !== this.sessions) {
        this.sessions = nextSessions;
        this.options.onSessions(this.sessions);
      }
      if (reduced.needsFullFetch) this.requestFullFetch();
    };

    const onCaughtUp = (raw: Event) => {
      if (this.stopped || epoch !== this.epoch) return;
      const data = parseData(raw) as { degraded?: unknown } | null;
      const transition = reduceOwnerStreamSignal(this.streamState, {
        type: 'caught_up',
        ...(data?.degraded === true ? { degraded: true } : {}),
      });
      this.streamState = transition.state;
      if (transition.initializedNow) this.options.onInitialized?.();
      if (transition.needsFullFetch) this.requestFullFetch();
      if (data?.degraded !== true && this.lastFullFetchFailed) {
        this.lastFullFetchFailed = false;
        this.requestFullFetch();
      }
    };

    const onOwnerMoved = () => {
      if (this.stopped || epoch !== this.epoch) return;
      const transition = reduceOwnerStreamSignal(this.streamState, { type: 'owner_moved' });
      this.streamState = transition.state;
      if (!transition.reconnect) return;
      // A fresh native instance has no inherited Last-Event-ID. Closing first
      // also prevents the clean server EOF from reconnecting the retired owner.
      source.close();
      this.epoch += 1;
      this.cursor = '0';
      this.journal = [];
      this.openStream();
      if (transition.needsFullFetch) this.requestFullFetch();
    };

    const onResyncRequired = (raw: Event) => {
      if (this.stopped || epoch !== this.epoch) return;
      const data = parseData(raw) as {
        type?: unknown;
        reason?: unknown;
        currentEventId?: unknown;
      } | null;
      if (
        data?.type !== 'resync_required' ||
        (data.reason !== 'cursor_ahead' && data.reason !== 'too_far_behind') ||
        !isDecimalCursor(data.currentEventId)
      ) {
        return;
      }
      this.journal = [];
      this.cursor = data.currentEventId;
      this.requestFullFetch();
    };

    for (const type of OWNER_SESSION_EVENT_TYPES) {
      source.addEventListener(type, onSessionEvent);
    }
    source.addEventListener('caught_up', onCaughtUp);
    source.addEventListener('resync_required', onResyncRequired);
    source.addEventListener('owner_moved', onOwnerMoved);
    source.onerror = () => {
      if (this.stopped || epoch !== this.epoch) return;
      this.observeStreamHealth(source, epoch);
    };
  }

  private observeStreamHealth(source: OwnerEventSource, epoch: number): void {
    if (this.stopped || epoch !== this.epoch || source !== this.source) return;
    if (source.readyState === 0) {
      this.connectingSamples += 1;
      if (!this.streamDegraded && this.connectingSamples >= STREAM_CONNECTING_SAMPLE_LIMIT) {
        this.streamDegraded = true;
        this.options.onStreamHealth?.(false);
      }
      return;
    }
    if (source.readyState !== 1) return;
    this.connectingSamples = 0;
    if (!this.streamDegraded) return;
    this.streamDegraded = false;
    this.options.onStreamHealth?.(true);
  }

  private runFullFetch(): void {
    this.requestInFlight = true;
    const epoch = this.epoch;
    const snapshotCursor = this.cursor;
    const settledTitleRevisions = new Map(
      [...this.titleMutations]
        .filter(([, mutation]) => mutation.settled)
        .map(([sessionId, mutation]) => [sessionId, mutation.revision]),
    );
    void this.options
      .fetchSessions()
      .then((snapshot) => {
        if (this.stopped || epoch !== this.epoch) return;
        const snapshotSessionIds = new Set(snapshot.map((session) => session.id));
        let merged: readonly ProHomeSessionItem[] = newestFirst(snapshot).map((session) => {
          const mutation = this.titleMutations.get(session.id);
          if (!mutation) return session;
          if (!mutation.settled || mutation.revision !== settledTitleRevisions.get(session.id)) {
            // The PATCH was unresolved when this request began, or a newer
            // decision arrived afterwards, so the response cannot confirm it.
            return { ...session, title: mutation.title };
          }
          // This request began after the PATCH settled, so its row is now the
          // authoritative answer and may retire the local decision.
          this.titleMutations.delete(session.id);
          return session;
        });
        for (const [sessionId, revision] of settledTitleRevisions) {
          if (snapshotSessionIds.has(sessionId)) continue;
          const mutation = this.titleMutations.get(sessionId);
          if (!mutation?.settled || mutation.revision !== revision) continue;
          // A successful full read that began after settlement is equally
          // authoritative when the answer is "this session no longer exists".
          this.titleMutations.delete(sessionId);
        }
        let needsFullFetch = false;
        for (const event of this.journal) {
          if (compareDecimalCursor(event.id, snapshotCursor) <= 0) continue;
          const reduced = reduceOwnerSessionEvent(merged, event);
          const titleOrderAmbiguous = event.type === 'session_title' && reduced.sessions === merged;
          merged = reduced.sessions;
          needsFullFetch ||= reduced.needsFullFetch || titleOrderAmbiguous;
        }
        merged = this.overlaySessionTitleMutations(merged);
        this.sessions = merged;
        this.journal = [];
        this.lastFullFetchFailed = false;
        this.options.onSessions(merged, 'snapshot');
        // Unconditionally authoritative: this snapshot is a full read of the
        // list, so it is correct even while the push channel is down. Gating
        // 'ready' on stream health left a dead stream + healthy REST stuck in
        // an error state that the rail's retry button could never clear.
        this.options.onState('ready');
        if (needsFullFetch) this.requestPending = true;
      })
      .catch(() => {
        if (!this.stopped && epoch === this.epoch) {
          this.lastFullFetchFailed = true;
          this.options.onState('error');
        }
      })
      .finally(() => {
        this.requestInFlight = false;
        if (!this.stopped && this.requestPending) {
          this.requestPending = false;
          this.runFullFetch();
        }
      });
  }

  private overlaySessionTitleMutations(
    sessions: readonly ProHomeSessionItem[],
  ): readonly ProHomeSessionItem[] {
    let changed = false;
    const next = sessions.map((session) => {
      const mutation = this.titleMutations.get(session.id);
      if (!mutation || mutation.title === session.title) return session;
      changed = true;
      return { ...session, title: mutation.title };
    });
    return changed ? next : sessions;
  }

  private scheduleReconciliation(): void {
    const random = this.options.random ?? Math.random;
    const delay = SESSION_RECONCILE_MIN_MS + random() * SESSION_RECONCILE_JITTER_MS;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      if (this.stopped) return;
      this.requestFullFetch();
      this.scheduleReconciliation();
    }, delay);
  }
}
