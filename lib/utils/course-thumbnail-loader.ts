import type { CourseThumbnail } from '@/lib/utils/course-cover';

/**
 * Lazy, bounded loader for the home library's course thumbnails.
 *
 * A thumbnail costs a full document read plus the cover's media bytes, so the
 * library never loads them up front: a card asks for its own thumbnail while
 * it is near the viewport ({@link CourseThumbnailLoader.request}), at most
 * `concurrency` loads run at once, and a card that leaves the viewport before
 * its load starts withdraws it. {@link CourseThumbnailLoader.dispose} (leaving
 * the page) drops the queue and aborts the loads in flight.
 *
 * Entries are versioned by the course's `updatedAt`: asking again with the
 * same version is free, a newer version reloads while the previous thumbnail
 * stays visible, and a superseded or discarded thumbnail is released.
 */

export interface CourseThumbnailLoaderOptions {
  /** Resolve a course's cover at `version`, or null when it has none. */
  readonly load: (
    stageId: string,
    version: number,
    signal: AbortSignal,
  ) => Promise<CourseThumbnail | null>;
  /** Release what a loaded thumbnail holds (a slide's object URLs). */
  readonly release: (cover: CourseThumbnail) => void;
  /** Maximum loads in flight at once. */
  readonly concurrency: number;
  /** Called after the visible thumbnail set changed. */
  readonly onChange: () => void;
  /** A load failed; the course keeps its previous thumbnail (or none) until its next version. */
  readonly onError?: (stageId: string, error: unknown) => void;
}

interface Entry {
  readonly version: number;
  readonly cover: CourseThumbnail | null;
}

interface Job {
  readonly stageId: string;
  readonly version: number;
  /** Requesters still interested; a queued job with none is dropped. */
  interest: number;
}

const noop = () => {};

export class CourseThumbnailLoader {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: Job[] = [];
  private readonly inFlight = new Map<Job, AbortController>();
  private disposed = false;

  constructor(private readonly options: CourseThumbnailLoaderOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error('CourseThumbnailLoader: concurrency must be a positive integer');
    }
  }

  /**
   * Ask for a course's thumbnail at `version`. Returns a withdraw function: a
   * load that has not started yet is dropped once every requester withdrew;
   * one already in flight finishes and is cached.
   */
  request(stageId: string, version: number): () => void {
    if (this.disposed) return noop;
    const entry = this.entries.get(stageId);
    if (entry && entry.version >= version) return noop;
    for (const job of this.inFlight.keys()) {
      if (job.stageId === stageId && job.version >= version) return noop;
    }
    let job = this.queue.find((queued) => queued.stageId === stageId);
    if (job && job.version < version) {
      this.queue.splice(this.queue.indexOf(job), 1);
      job = undefined;
    }
    if (!job) {
      job = { stageId, version, interest: 0 };
      this.queue.push(job);
    }
    const target = job;
    target.interest += 1;
    this.pump();
    let withdrawn = false;
    return () => {
      if (withdrawn) return;
      withdrawn = true;
      target.interest -= 1;
      const index = this.queue.indexOf(target);
      if (target.interest <= 0 && index !== -1) this.queue.splice(index, 1);
    };
  }

  /** The loaded thumbnails: a course's cover, or null for a course without one. */
  snapshot(): Record<string, CourseThumbnail | null> {
    const result: Record<string, CourseThumbnail | null> = {};
    for (const [stageId, entry] of this.entries) result[stageId] = entry.cover;
    return result;
  }

  /** Forget (and release) the thumbnails of courses no longer in the library. */
  retain(stageIds: ReadonlySet<string>): void {
    let changed = false;
    for (const [stageId, entry] of this.entries) {
      if (stageIds.has(stageId)) continue;
      this.entries.delete(stageId);
      if (entry.cover) this.options.release(entry.cover);
      changed = true;
    }
    if (changed) this.options.onChange();
  }

  /** Drop queued loads, abort the ones in flight, and release every thumbnail. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.length = 0;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    for (const entry of this.entries.values()) {
      if (entry.cover) this.options.release(entry.cover);
    }
    this.entries.clear();
  }

  private pump(): void {
    while (!this.disposed && this.inFlight.size < this.options.concurrency) {
      const job = this.queue.shift();
      if (!job) return;
      const controller = new AbortController();
      this.inFlight.set(job, controller);
      void this.run(job, controller);
    }
  }

  private async run(job: Job, controller: AbortController): Promise<void> {
    let cover: CourseThumbnail | null = null;
    let failed = false;
    try {
      cover = await this.options.load(job.stageId, job.version, controller.signal);
    } catch (error) {
      failed = true;
      if (!controller.signal.aborted) this.options.onError?.(job.stageId, error);
    }
    this.inFlight.delete(job);
    if (this.disposed || controller.signal.aborted) {
      if (cover) this.options.release(cover);
      return;
    }
    const previous = this.entries.get(job.stageId);
    if (previous && previous.version > job.version) {
      if (cover) this.options.release(cover);
    } else if (failed) {
      // Keep showing what the course had; the next version retries.
      this.entries.set(job.stageId, { version: job.version, cover: previous?.cover ?? null });
      if (!previous) this.options.onChange();
    } else {
      this.entries.set(job.stageId, { version: job.version, cover });
      if (previous?.cover) this.options.release(previous.cover);
      this.options.onChange();
    }
    this.pump();
  }
}
