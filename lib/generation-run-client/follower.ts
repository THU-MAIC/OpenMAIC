/**
 * Follow one generation run: its snapshot, then its ordered event log over
 * SSE (`GET /api/generation-runs/:id/events?after=<seq>`). A reconnecting
 * `EventSource` resumes from the last frame's id; a `resync` frame (the log was
 * compacted behind the cursor) is answered by reading the snapshot again, and
 * frames that arrive meanwhile are folded in after it. Any page, reload or
 * device rebuilds the same view this way. Closing the stream never affects the
 * run.
 *
 * Framework-free so it can be driven directly; `useGenerationRun` is its React
 * face.
 */
import { GENERATION_RUN_EVENT_TYPES } from '@/lib/server/generation/run/types';

import { applyRunEvent, followFrom, viewFromSnapshot } from './reducer';
import { isFinishedRunState, type RunEvent, type RunSnapshot, type RunView } from './types';

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
}

export interface RunFollowerDeps {
  fetchSnapshot: (runId: string) => Promise<RunSnapshot | null>;
  /** Null when the browser has no `EventSource`: the snapshot is polled instead. */
  openEvents: ((url: string) => RunEventSource) | null;
  onChange: (state: RunFollowerState) => void;
  onWarn?: (message: string, error: unknown) => void;
  pollIntervalMs?: number;
}

/** Keep what only the log carries when a snapshot replaces the view. */
export function mergeSnapshotView(current: RunView | null, snapshot: RunSnapshot): RunView {
  const next = viewFromSnapshot(snapshot);
  if (!current) return next;
  return {
    ...next,
    researchSources: current.researchSources,
    readyScenes: current.readyScenes,
    skippedScenes: current.skippedScenes,
    generatedAgents: next.generatedAgents ?? current.generatedAgents,
    streamingOutlines: next.outline ? next.streamingOutlines : current.streamingOutlines,
    stepStartedSeq: current.stepStartedSeq,
    failedSeq: next.error ? (current.error ? current.failedSeq : next.failedSeq) : 0,
    media: Object.fromEntries(
      Object.entries(next.media).map(([id, state]) => [
        id,
        current.media[id]?.status === state.status ? current.media[id]! : state,
      ]),
    ),
    seq: Math.max(next.seq, current.seq),
  };
}

export class RunFollower {
  private state: RunFollowerState = { view: null, status: 'loading', caughtUp: false };
  private source: RunEventSource | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncing: Promise<void> | null = null;
  private buffered: RunEvent[] = [];
  private closed = false;

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

  private fold(event: RunEvent): void {
    if (this.resyncing) {
      this.buffered.push(event);
      return;
    }
    if (!this.state.view) return;
    this.publish({ view: applyRunEvent(this.state.view, event) });
    this.idleIfSettled();
  }

  private async readSnapshot(): Promise<void> {
    const snapshot = await this.deps.fetchSnapshot(this.runId);
    if (this.closed) return;
    if (!snapshot) {
      this.publish({ status: 'missing' });
      return;
    }
    let next = mergeSnapshotView(this.state.view, snapshot);
    const pending = this.buffered;
    this.buffered = [];
    for (const event of pending) next = applyRunEvent(next, event);
    this.publish({ view: next });
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
    const event: RunEvent = {
      seq: frame.seq,
      type: frame.type as RunEvent['type'],
      data: (frame.data ?? {}) as Record<string, unknown>,
    };
    this.fold(event);
    // An edited outline's items are in the snapshot only.
    if (event.type === 'outline_confirmed' && event.data.edited === true) void this.resync();
  };

  private poll = async () => {
    try {
      await this.readSnapshot();
    } catch (error) {
      this.deps.onWarn?.('Reading the run snapshot failed', error);
    }
    if (!this.closed) this.pollTimer = setTimeout(this.poll, this.deps.pollIntervalMs ?? 3_000);
  };

  async start(): Promise<void> {
    let snapshot: RunSnapshot | null;
    try {
      snapshot = await this.deps.fetchSnapshot(this.runId);
    } catch (error) {
      this.deps.onWarn?.('Reading the run failed', error);
      this.publish({ status: 'error' });
      return;
    }
    if (this.closed) return;
    if (!snapshot) {
      this.publish({ status: 'missing' });
      return;
    }
    const start = followFrom(snapshot);
    if (!this.deps.openEvents) {
      this.publish({ view: start.view, status: 'live', caughtUp: true });
      this.pollTimer = setTimeout(this.poll, this.deps.pollIntervalMs ?? 3_000);
      return;
    }
    this.publish({ view: start.view, status: 'live' });
    this.openEvents(start.after);
  }

  private openEvents(after: number): void {
    if (this.closed || this.source || !this.deps.openEvents) return;
    const source = this.deps.openEvents(
      `/api/generation-runs/${encodeURIComponent(this.runId)}/events?after=${after}`,
    );
    this.source = source;
    for (const type of GENERATION_RUN_EVENT_TYPES) source.addEventListener(type, this.onFrame);
    source.addEventListener('resync', () => void this.resync());
    source.addEventListener('caught_up', () => {
      this.publish({ caughtUp: true });
      this.idleIfSettled();
    });
  }

  /**
   * A finished run with nothing generating changes only through a command
   * (a media Retry): the stream is closed until `wake` reopens it.
   */
  private idleIfSettled(): void {
    const view = this.state.view;
    if (!view || !this.state.caughtUp || !this.source) return;
    if (!isFinishedRunState(view.state)) return;
    const busy = Object.values(view.media).some(
      (media) => media.status === 'pending' || media.status === 'generating',
    );
    if (busy) return;
    this.source.close();
    this.source = null;
  }

  /** Follow the run's events again (after a command to a run whose stream was closed). */
  wake(): void {
    if (this.state.view) this.openEvents(this.state.view.seq);
  }

  close(): void {
    this.closed = true;
    this.source?.close();
    this.source = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}
