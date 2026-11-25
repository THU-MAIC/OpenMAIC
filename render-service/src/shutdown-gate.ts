/**
 * When a process that received SIGTERM may exit.
 *
 * Admission is closed by then (`RenderCoordinator#closeAdmission`). The
 * process exits once all of these hold:
 *
 * - the coordinator has nothing reserved, queued or running (`idle()`);
 * - no upload handler is still finishing its cleanup and response;
 * - every succeeded job this process still holds had its output downloaded
 *   once to the end. The job index and the output live only in this process,
 *   so a caller that fetches a finished output after polling for it (the
 *   app's durable export queue) must get it before the process goes, or the
 *   job is lost and rendered again.
 *
 * An output nobody fetches keeps the process up until the platform's grace
 * period ends, as it did before this handler existed; a reaped job no longer
 * counts.
 */
import type { serve } from '@hono/node-server';
import { once } from 'node:events';
import { getPath } from 'hono/utils/url';
import type { JobStore } from './job-store.js';

type NodeFetch = Parameters<typeof serve>[0]['fetch'];

const DOWNLOAD_PATH = /^\/owner-bound\/render\/([^/]+)\/download$/;

export class ShutdownGate {
  private coordinatorIdle = false;
  private uploads = 0;
  private exited = false;
  /** Succeeded jobs whose output was downloaded to the end at least once. */
  private readonly fetched = new Set<string>();

  constructor(
    private readonly jobs: JobStore,
    private readonly exit: () => void,
  ) {}

  /** The coordinator's `onIdle`: admission is closed and nothing is left in it. */
  idle(): void {
    this.coordinatorIdle = true;
    void this.settle();
  }

  /** A reaped job no longer waits for its output to be fetched. */
  forget(jobId: string): void {
    this.fetched.delete(jobId);
    void this.settle();
  }

  /**
   * The HTTP handler, tracking what the exit waits for: upload handlers until
   * their response is done (or the client is gone), and output downloads
   * that reach their last byte.
   */
  wrap(fetch: NodeFetch): NodeFetch {
    return (request, env) => {
      const path = getPath(request);
      if (request.method === 'POST' && path === '/owner-bound/render') {
        // Releasing the last reservation can make the coordinator idle before
        // the upload handler cleans up and the HTTP adapter writes its
        // response; a disconnected client still needs that cleanup.
        this.uploads += 1;
        const closed = once(env.outgoing, 'close');
        const response = fetch(request, env);
        void Promise.allSettled([response, closed]).then(() => {
          this.uploads -= 1;
          void this.settle();
        });
        return response;
      }
      const download = request.method === 'GET' ? DOWNLOAD_PATH.exec(path) : null;
      if (download) {
        // getPath already decodes the unreserved characters used by job UUIDs.
        const jobId = download[1]!;
        // 'finish': the whole response was handed to the OS. A client that
        // goes away mid-download never gets there, and may fetch again.
        env.outgoing.once('finish', () => {
          const status = env.outgoing.statusCode;
          if (status === 200 || status === 302) {
            this.fetched.add(jobId);
            void this.settle();
          }
        });
      }
      return fetch(request, env);
    };
  }

  private async settle(): Promise<void> {
    if (this.exited || !this.coordinatorIdle || this.uploads > 0) return;
    const unfetched = (await this.jobs.list()).some(
      (job) => job.status === 'succeeded' && !this.fetched.has(job.id),
    );
    if (unfetched || this.exited || this.uploads > 0) return;
    this.exited = true;
    this.exit();
  }
}
