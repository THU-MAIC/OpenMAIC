/**
 * Follow one generation run: its snapshot, then its ordered event log over
 * SSE (`GET /api/generation-runs/:id/events?after=<seq>`). A reconnecting
 * `EventSource` resumes from the last frame's id; a `resync` frame (the log was
 * compacted behind the cursor) is answered by reading the snapshot again, and
 * frames that arrive meanwhile are folded in after it. Any page, reload or
 * device rebuilds the same view this way. Closing the stream never affects the
 * run.
 *
 * The stream is held only while the run can change on its own (it is
 * executing, or generating media). A run that waits for its owner (the
 * outline confirmation, a Retry of a paused step) or is settled is read again
 * now and then instead; a command sent from this page wakes the stream again.
 * A stream the server refuses or drops for good (a stream cap, a deploy) is
 * reopened with a backoff, reading the snapshot meanwhile; so is a snapshot
 * that cannot be read.
 *
 * Framework-free so it can be driven directly; `useGenerationRun` is its React
 * face.
 */
import { GENERATION_RUN_EVENT_TYPES } from '@/lib/server/generation/run/types';

import { applyRunEvent, followFrom, viewFromSnapshot } from './reducer';
import { isFinishedRunState, type RunEvent, type RunSnapshot, type RunView } from './types';

/** `error`: the run could not be read yet (the follower keeps trying). */
export type RunFollowStatus = 'loading' | 'live' | 'missing' | 'error';

export interface RunFollowerState {
  view: RunView | null;
  status: RunFollowStatus;
  /** True once the stream replayed everything the run logged before it attached. */
  caughtUp: boolean;
}

/** The part of `EventSource` the follower uses. */
export interface RunEventSource {
  addEventListener(type: string, listener: (message: MessageEvent<string>) => void): void;
  close(): void;
  /** `EventSource.CLOSED` (2) once the browser gave up on the stream. */
  readonly readyState?: number;
}

export interface RunFollowerDeps {
  fetchSnapshot: (runId: string, signal?: AbortSignal) => Promise<RunSnapshot | null>;
  /** How long one snapshot read may take before it counts as failed (default 15 s). */
  readTimeoutMs?: number;
  /** Null when the browser has no `EventSource`: the snapshot is polled instead. */
  openEvents: ((url: string) => RunEventSource) | null;
  onChange: (state: RunFollowerState) => void;
  onWarn?: (message: string, error: unknown) => void;
  /** How often a run without a stream is read (default 3 s while it can change, else 15 s). */
  pollIntervalMs?: number;
  quietPollIntervalMs?: number;
  /** Whether the page is shown: a waiting run is read every 5 s then. */
  isVisible?: () => boolean;
  /** A [0, 1) source for the backoff's jitter (tests fix it). */
  random?: () => number;
  /** The first delay before a failed read or stream is tried again (doubles to 30 s). */
  retryBaseMs?: number;
}

const EVENT_SOURCE_CLOSED = 2;
const MAX_RETRY_MS = 30_000;

/** Whether the run can change without a command: what the stream is held for. */
export function runIsMoving(view: RunView): boolean {
  if (view.state === 'preparing' || view.state === 'outlining' || view.state === 'generating') {
    return true;
  }
  // A paused or finished run whose media is still being generated.
  return Object.values(view.media).some(
    (media) => media.status === 'pending' || media.status === 'generating',
  );
}

/**
 * Keep what only the log carries when a snapshot replaces the view. A run
 * whose outline is still streaming keeps the view's cursor: the items it
 * logged since are only in the log, and the stream replays them from there.
 */
export function mergeSnapshotView(current: RunView | null, snapshot: RunSnapshot): RunView {
  const next = viewFromSnapshot(snapshot);
  if (!current) return next;
  const logOnly =
    !snapshot.outline && (snapshot.state === 'preparing' || snapshot.state === 'outlining');
  if (logOnly) return current;
  return {
    ...next,
    // A snapshot may have been read before the last live scene event.
    narrationUnvoiced: Math.max(next.narrationUnvoiced, current.narrationUnvoiced),
    researchSources: current.researchSources,
    readyScenes: current.readyScenes,
    skippedScenes: current.skippedScenes,
    generatedAgents: next.generatedAgents ?? current.generatedAgents,
    streamingOutlines: next.outline ? next.streamingOutlines : current.streamingOutlines,
    stepStartedSeq: current.stepStartedSeq,
    seq: Math.max(next.seq, current.seq),
  };
}

export class RunFollower {
  private state: RunFollowerState = { view: null, status: 'loading', caughtUp: false };
  private source: RunEventSource | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resyncing: Promise<void> | null = null;
  private buffered: RunEvent[] = [];
  private closed = false;
  private failures = 0;

  constructor(
    private readonly runId: string,
    private readonly deps: RunFollowerDeps,
  ) {}

  get current(): RunFollowerState {
    return this.state;
  }

  private publish(patch: Partial<RunFollowerState>): void {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }

  private retryDelay(): number {
    const base = this.deps.retryBaseMs ?? 1_000;
    const delay = Math.min(base * 2 ** Math.max(0, this.failures - 1), MAX_RETRY_MS);
    // Jitter, so tabs refused together do not come back together.
    return Math.round(delay * (0.75 + (this.deps.random ?? Math.random)() * 0.5));
  }

  private schedule(delayMs: number, run: () => void): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      run();
    }, delayMs);
  }

  private fold(event: RunEvent): void {
    if (this.resyncing) {
      this.buffered.push(event);
      return;
    }
    if (!this.state.view) return;
    this.publish({ view: applyRunEvent(this.state.view, event) });
    this.settleTransport();
  }

  private reading: Promise<void> = Promise.resolve();
  private readonly outstanding = new Set<AbortController>();

  /** One snapshot read, bounded: one that never settles must not hold every later read. */
  private async fetchSnapshot(): Promise<RunSnapshot | null> {
    const controller = new AbortController();
    this.outstanding.add(controller);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Reading the run timed out'));
      }, this.deps.readTimeoutMs ?? 15_000);
    });
    try {
      return await Promise.race([this.deps.fetchSnapshot(this.runId, controller.signal), timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
      this.outstanding.delete(controller);
    }
  }

  /** Snapshot reads one at a time, so an older answer never lands after a newer one. */
  private readSnapshot(): Promise<void> {
    const next = this.reading.catch(() => {}).then(() => this.readSnapshotNow());
    this.reading = next;
    return next;
  }

  private async readSnapshotNow(): Promise<void> {
    const snapshot = await this.fetchSnapshot();
    if (this.closed) return;
    // An answer older than what the view already holds changes nothing.
    if (snapshot && this.state.view && snapshot.seq < this.state.view.seq) {
      this.publish({ status: 'live' });
      return;
    }
    if (!snapshot) {
      this.closeSource();
      this.publish({ status: 'missing' });
      return;
    }
    let next = mergeSnapshotView(this.state.view, snapshot);
    const pending = this.buffered;
    this.buffered = [];
    for (const event of pending) next = applyRunEvent(next, event);
    this.publish({ view: next, status: 'live' });
  }

  /** Read the snapshot again (a `resync`, an edited outline, after a command). */
  resync(): Promise<void> {
    if (!this.resyncing) {
      this.resyncing = this.readSnapshot()
        .catch((error) => this.deps.onWarn?.('Reading the run snapshot failed', error))
        .finally(() => {
          this.resyncing = null;
          const pending = this.buffered;
          this.buffered = [];
          for (const event of pending) this.fold(event);
          this.settleTransport();
        });
    }
    return this.resyncing;
  }

  private onFrame = (message: MessageEvent<string>) => {
    let frame: { seq?: unknown; type?: unknown; data?: unknown };
    try {
      frame = JSON.parse(message.data) as typeof frame;
    } catch {
      return;
    }
    if (typeof frame.seq !== 'number' || typeof frame.type !== 'string') return;
    this.failures = 0;
    const event: RunEvent = {
      seq: frame.seq,
      type: frame.type as RunEvent['type'],
      data: (frame.data ?? {}) as Record<string, unknown>,
    };
    this.fold(event);
    // An edited outline's items are in the snapshot only.
    if (event.type === 'outline_confirmed' && event.data.edited === true) void this.resync();
  };

  async start(): Promise<void> {
    let snapshot: RunSnapshot | null;
    try {
      snapshot = await this.fetchSnapshot();
    } catch (error) {
      if (this.closed) return;
      // Not "no such run": the read failed, and is tried again.
      this.failures += 1;
      this.deps.onWarn?.('Reading the run failed', error);
      this.publish({ status: 'error' });
      this.schedule(this.retryDelay(), () => void this.start());
      return;
    }
    if (this.closed) return;
    this.failures = 0;
    if (!snapshot) {
      this.publish({ status: 'missing' });
      return;
    }
    const start = followFrom(snapshot);
    this.publish({ view: start.view, status: 'live', caughtUp: !this.deps.openEvents });
    if (this.deps.openEvents && runIsMoving(start.view)) {
      this.openEvents(start.after);
    } else {
      // A run that waits or is settled: what it logged is in its snapshot.
      this.publish({ caughtUp: true });
      this.settleTransport();
    }
  }

  private openEvents(after: number): void {
    if (this.closed || this.source || !this.deps.openEvents) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const source = this.deps.openEvents(
      `/api/generation-runs/${encodeURIComponent(this.runId)}/events?after=${after}`,
    );
    this.source = source;
    // Until the stream replays what the run logged since `after`.
    if (this.state.caughtUp) this.publish({ caughtUp: false });
    for (const type of GENERATION_RUN_EVENT_TYPES) source.addEventListener(type, this.onFrame);
    source.addEventListener('resync', () => void this.resync());
    source.addEventListener('caught_up', () => {
      this.failures = 0;
      this.publish({ caughtUp: true });
      this.settleTransport();
    });
    source.addEventListener('error', () => {
      // The browser reconnects by itself unless it gave up (a refusal: the
      // stream cap, a 404 or a 5xx).
      if (this.source !== source || source.readyState !== EVENT_SOURCE_CLOSED) return;
      this.closeSource();
      this.failures += 1;
      this.deps.onWarn?.('The run event stream closed', null);
      this.schedule(this.retryDelay(), () => void this.reconnect());
    });
  }

  /** After a dropped stream: read the snapshot, then follow again from it. */
  private async reconnect(): Promise<void> {
    try {
      await this.readSnapshot();
    } catch (error) {
      this.failures += 1;
      this.deps.onWarn?.('Reading the run snapshot failed', error);
      this.schedule(this.retryDelay(), () => void this.reconnect());
      return;
    }
    this.settleTransport();
  }

  private closeSource(): void {
    this.source?.close();
    this.source = null;
  }

  /** Hold the stream while the run can change on its own; else read it now and then. */
  private settleTransport(): void {
    const view = this.state.view;
    if (this.closed || !view || this.resyncing || this.state.status === 'missing') return;
    if (runIsMoving(view) && this.deps.openEvents) {
      if (!this.source && !this.timer) this.openEvents(view.seq);
      return;
    }
    if (this.source && !this.state.caughtUp) return;
    this.closeSource();
    if (this.timer) return;
    const quiet = !runIsMoving(view);
    const interval = quiet
      ? (this.deps.quietPollIntervalMs ??
        (isFinishedRunState(view.state)
          ? 30_000
          : (this.deps.isVisible?.() ?? false)
            ? 5_000
            : 15_000))
      : (this.deps.pollIntervalMs ?? 3_000);
    this.schedule(interval, () => void this.poll());
  }

  private async poll(): Promise<void> {
    try {
      await this.readSnapshot();
      this.failures = 0;
    } catch (error) {
      this.failures += 1;
      this.deps.onWarn?.('Reading the run snapshot failed', error);
      this.schedule(this.retryDelay(), () => void this.poll());
      return;
    }
    this.settleTransport();
  }

  /**
   * Read the run again now and follow it as it is: after a command from this
   * page (a confirmation, a Retry), or when the page is shown again. A page
   * shown again while a failed read or stream waits out its backoff keeps
   * waiting: the backoff is what keeps a refused stream from hammering.
   */
  async wake(reason: 'command' | 'visible' = 'command'): Promise<void> {
    if (this.closed) return;
    if (reason === 'visible' && this.failures > 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (reason === 'command') this.failures = 0;
    if (!this.state.view) {
      await this.start();
      return;
    }
    await this.resync();
  }

  close(): void {
    this.closed = true;
    for (const controller of this.outstanding) controller.abort();
    this.outstanding.clear();
    this.closeSource();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
