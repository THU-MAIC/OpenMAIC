/**
 * The owner's active generation runs, for course lists: `GET
 * /api/generation-runs?active=1` first, then, while any run is in progress
 * (preparing, outlining or generating), the owner stream (`GET
 * /api/generation-runs/events`), which sends every active run at attach and a
 * run's snapshot each time it changes, including the change that completes or
 * ends it. Runs that only wait for their owner (outline confirmation, a paused
 * step) change only through a command, so with none in progress the list is
 * read again now and then instead; an idle page holds no connection. A stream
 * that is refused or dropped for good is replaced by reading the list again,
 * with a backoff.
 *
 * Framework-free so it can be driven directly; `useOwnerRuns` is its React face.
 */
import type { RunLimits } from './api';
import { isFinishedRunState, type RunSnapshot } from './types';
import type { RunEventSource } from './follower';

export interface OwnerRunsDeps {
  listActive: () => Promise<{ runs: RunSnapshot[]; limits?: RunLimits }>;
  /** Null without `EventSource`: the list is read again instead. */
  openStream: (() => RunEventSource) | null;
  onChange: (runs: RunSnapshot[]) => void;
  /** A run gained its course or left the list (finished): the library should be read again. */
  onCourseChanged?: (run: RunSnapshot) => void;
  onWarn?: (message: string, error: unknown) => void;
  /** How often the list is read without a stream (default 30 s). */
  idlePollMs?: number;
  retryBaseMs?: number;
}

const EVENT_SOURCE_CLOSED = 2;
const MAX_RETRY_MS = 30_000;

/** Keep each run's newest snapshot; finished runs leave the list. */
export function mergeOwnerRun(runs: readonly RunSnapshot[], run: RunSnapshot): RunSnapshot[] {
  const index = runs.findIndex((candidate) => candidate.id === run.id);
  if (index >= 0 && runs[index]!.seq > run.seq) return runs as RunSnapshot[];
  const rest = runs.filter((candidate) => candidate.id !== run.id);
  if (isFinishedRunState(run.state)) return rest;
  const next = [...rest];
  next.splice(index >= 0 ? index : 0, 0, run);
  return next;
}

/** A run that changes without a command from its owner. */
export function runInProgress(run: Pick<RunSnapshot, 'state'>): boolean {
  return run.state === 'preparing' || run.state === 'outlining' || run.state === 'generating';
}

export class OwnerRunsWatcher {
  private runs: RunSnapshot[] = [];
  private limits: RunLimits | undefined;
  private source: RunEventSource | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private failures = 0;

  constructor(private readonly deps: OwnerRunsDeps) {}

  get current(): { runs: RunSnapshot[]; limits: RunLimits | undefined } {
    return { runs: this.runs, limits: this.limits };
  }

  private replace(next: RunSnapshot[]): void {
    const previous = this.runs;
    this.runs = next;
    if (this.closed) return;
    this.deps.onChange(next);
    for (const run of previous) {
      // A run that left the list finished: its course is in the library now.
      if (!next.some((candidate) => candidate.id === run.id)) this.deps.onCourseChanged?.(run);
    }
    for (const run of next) {
      const before = previous.find((candidate) => candidate.id === run.id);
      if (run.stageId && before?.stageId !== run.stageId) this.deps.onCourseChanged?.(run);
    }
    this.settle();
  }

  /** Forget a run this page discarded. */
  forget(runId: string): void {
    this.runs = this.runs.filter((run) => run.id !== runId);
    if (!this.closed) this.deps.onChange(this.runs);
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delayMs);
  }

  private settle(): void {
    if (this.closed) return;
    if (this.runs.some(runInProgress) && this.deps.openStream) {
      if (!this.source) this.open();
      return;
    }
    this.source?.close();
    this.source = null;
    if (!this.timer) this.schedule(this.deps.idlePollMs ?? 30_000);
  }

  private open(): void {
    if (this.closed || this.source || !this.deps.openStream) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const source = this.deps.openStream();
    this.source = source;
    source.addEventListener('runs', (message) => {
      try {
        const frame = JSON.parse(message.data) as { runs?: RunSnapshot[] };
        this.failures = 0;
        if (Array.isArray(frame.runs)) this.replace(frame.runs);
      } catch {
        /* a malformed frame changes nothing */
      }
    });
    source.addEventListener('run', (message) => {
      try {
        const frame = JSON.parse(message.data) as { run?: RunSnapshot };
        if (frame.run) this.replace(mergeOwnerRun(this.runs, frame.run));
      } catch {
        /* a malformed frame changes nothing */
      }
    });
    source.addEventListener('error', () => {
      if (this.source !== source || source.readyState !== EVENT_SOURCE_CLOSED) return;
      source.close();
      this.source = null;
      this.failures += 1;
      this.deps.onWarn?.('The run list stream closed', null);
      this.schedule(this.retryDelay());
    });
  }

  private retryDelay(): number {
    const base = this.deps.retryBaseMs ?? 1_000;
    return Math.min(base * 2 ** Math.max(0, this.failures - 1), MAX_RETRY_MS);
  }

  /** Read the list now (on mount, when the page is shown again, after a start). */
  async poll(): Promise<void> {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      const listed = await this.deps.listActive();
      if (this.closed) return;
      this.failures = 0;
      this.limits = listed.limits ?? this.limits;
      this.replace(listed.runs);
    } catch (error) {
      this.failures += 1;
      this.deps.onWarn?.('Listing the active generations failed', error);
      this.schedule(this.retryDelay());
    }
  }

  close(): void {
    this.closed = true;
    this.source?.close();
    this.source = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
