/**
 * JobStore — the seam that makes the render service horizontally scalable
 * later without touching the HTTP contract or the app.
 *
 * Part A ships {@link InMemoryJobStore} (single-process, fine for OSS
 * single-host). A demo deployment drops in a `RedisJobStore` implementing this
 * same interface so poll/download requests can be served by any replica. The
 * routes only ever see `JobStore`.
 */
import type { RenderJobPatch, RenderJobRecord, RenderOwnerId } from './types.js';
import { isTerminal } from './types.js';

export interface JobStore {
  create(record: RenderJobRecord): Promise<void>;
  get(id: string): Promise<RenderJobRecord | null>;
  getForOwner(id: string, ownerId: RenderOwnerId): Promise<RenderJobRecord | null>;
  /** Merge a partial patch into an existing record; no-op if it's gone. */
  update(id: string, patch: RenderJobPatch): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<RenderJobRecord[]>;
}

/** Process-local job registry backed by a Map, with a TTL sweeper for finished jobs. */
export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, RenderJobRecord>();
  private readonly sweeper: NodeJS.Timeout;

  /**
   * @param ttlMs        finished jobs older than this are reaped
   * @param onReap       called with a reaped record so the caller can delete its temp files
   */
  constructor(
    private readonly ttlMs: number,
    private readonly onReap?: (record: RenderJobRecord) => void,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    // Don't keep the process alive just for the sweeper.
    this.sweeper.unref?.();
  }

  async create(record: RenderJobRecord): Promise<void> {
    this.jobs.set(record.id, record);
  }

  async get(id: string): Promise<RenderJobRecord | null> {
    return this.jobs.get(id) ?? null;
  }

  async getForOwner(id: string, ownerId: RenderOwnerId): Promise<RenderJobRecord | null> {
    const job = this.jobs.get(id);
    return job?.ownerId === ownerId ? job : null;
  }

  async update(id: string, patch: RenderJobPatch): Promise<void> {
    const existing = this.jobs.get(id);
    if (!existing) return;
    this.jobs.set(id, { ...existing, ...patch, updatedAtMs: Date.now() });
  }

  async remove(id: string): Promise<void> {
    this.jobs.delete(id);
  }

  async list(): Promise<RenderJobRecord[]> {
    return [...this.jobs.values()];
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (
        isTerminal(job.status) &&
        job.resources?.cleanupVerified !== false &&
        job.resources?.reservationReturned !== false &&
        now - job.updatedAtMs > this.ttlMs
      ) {
        this.jobs.delete(id);
        this.onReap?.(job);
      }
    }
  }
}
