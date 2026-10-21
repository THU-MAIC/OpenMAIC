/** Isolate Markdown/HTML parsing from the shared server event loop. */
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { isTransientExtractionError, MaterialExtractionError } from './errors';
import type { ImagePlan, ImageReference } from './document-image-apply.mjs';
import type { ImagePathIndex } from './document-images';

type PlanJob = { kind: 'plan'; text: string };
type RewriteJob = {
  kind: 'rewrite';
  blocks: Array<{ type: string; text?: string }>;
  index: ImagePathIndex;
};
type RewriteResult = { text: string; refs: ImageReference[] };
type Result = ImagePlan | RewriteResult;

/** A parser failure must end this extraction rather than try another provider. */
export class DocumentImageParseError extends MaterialExtractionError {
  constructor(cause: unknown) {
    super(
      `Document image parse failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      isTransientExtractionError(cause),
      { cause },
    );
    this.name = 'DocumentImageParseError';
  }
}

/** Admission refused parsing; callers may preserve text without image resolution. */
export class DocumentImageInputBudgetError extends DocumentImageParseError {}

const MAX_PARSER_WORKERS = 2;
// Node 22 can abort the parent when a worker reaches an explicit heap limit.
// Use input admission plus the execution timeout there; retain the measured
// worker limit on Node 24+, where the oversized standalone probe fails cleanly.
const PARSER_RESOURCE_LIMITS =
  Number(process.versions.node.split('.')[0]) >= 24 ? { maxOldGenerationSizeMb: 512 } : undefined;
// A (3.5 MB) and B (1.6 MB, up to 50k span pairs) fit these budgets. Larger
// payloads or denser HTML fail before cloning/allocating a parser tree. This
// counts tag starts conservatively, including those in code or malformed HTML.
const MAX_PARSE_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_PARSE_HTML_TAG_STARTS = 100_000;
// Charge UTF-16 string storage and per-entry overhead, not just UTF-8 bytes.
// This bounds retained queued payloads; it is not a bound on total process RSS.
const MAX_QUEUED_PARSE_BYTES = 64 * 1024 * 1024;
const MAX_QUEUE_WAIT_MS = 30_000;
let running = 0;
const pending: Array<() => void> = [];
let queuedBytes = 0;
interface ParseTask {
  promise: Promise<Result>;
  cancel: () => void;
  subscribers: number;
  abandoned: boolean;
}
const inFlightPlans = new Map<string, ParseTask>();

function drain() {
  while (running < MAX_PARSER_WORKERS && pending.length) pending.shift()!();
}

function inputBudget(job: PlanJob | RewriteJob): number {
  let bytes = 0;
  let retainedBytes = 1024;
  let tags = 0;
  const charge = (text: string, parse = false) => {
    bytes += Buffer.byteLength(text, 'utf8');
    retainedBytes += 2 * text.length;
    if (bytes > MAX_PARSE_INPUT_BYTES)
      throw new DocumentImageInputBudgetError(new Error('Document image input exceeds 4 MiB'));
    if (!parse) return;
    for (let at = text.indexOf('<'); at !== -1; at = text.indexOf('<', at + 1)) {
      const next = text.charCodeAt(at + (text[at + 1] === '/' ? 2 : 1));
      if ((next >= 65 && next <= 90) || (next >= 97 && next <= 122)) {
        if (++tags > MAX_PARSE_HTML_TAG_STARTS)
          throw new DocumentImageInputBudgetError(
            new Error('Document image input exceeds 100000 HTML tag starts'),
          );
      }
    }
  };
  if (job.kind === 'plan') charge(job.text, true);
  else {
    for (const block of job.blocks) {
      bytes += 128;
      retainedBytes += 128;
      charge(block.type);
      charge(block.text ?? '', block.type === 'markdown');
    }
    for (const entries of [job.index.exact, job.index.byBasename]) {
      for (const [path, key] of entries) {
        bytes += 128;
        retainedBytes += 128;
        charge(path);
        charge(key);
      }
    }
  }
  return retainedBytes;
}

function queueFailure(message: string): DocumentImageParseError {
  return new DocumentImageParseError(Object.assign(new Error(message), { retryable: true }));
}

function enqueue(job: PlanJob | RewriteJob, retainedBytes: number): ParseTask {
  const task: ParseTask = {
    promise: undefined!,
    cancel: () => {},
    subscribers: 0,
    abandoned: false,
  };
  task.promise = new Promise((resolve, reject) => {
    if (queuedBytes + retainedBytes > MAX_QUEUED_PARSE_BYTES) {
      reject(queueFailure('Document image parse queue exceeds 64 MiB'));
      return;
    }
    const removeQueued = () => {
      const at = pending.indexOf(start);
      if (at === -1) return false;
      pending.splice(at, 1);
      queuedBytes -= retainedBytes;
      clearTimeout(queueTimer);
      return true;
    };
    const start = () => {
      queuedBytes -= retainedBytes;
      clearTimeout(queueTimer);
      running++;
      let worker: Worker;
      try {
        // Keep this literal inside new Worker: Turbopack replaces it with the
        // bundled worker chunk used by standalone deployments.
        worker = new Worker(
          join(process.cwd(), 'lib/server/material-extraction/document-image-worker.mjs'),
          {
            workerData: job,
            resourceLimits: PARSER_RESOURCE_LIMITS,
          },
        );
      } catch (error) {
        running--;
        reject(new DocumentImageParseError(error));
        drain();
        return;
      }
      let settled = false;
      const finish = (error?: Error, result?: Result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Release the slot only after the old worker really stops.
        void worker.terminate().then(
          () => {
            running--;
            if (error) reject(new DocumentImageParseError(error));
            else resolve(result!);
            drain();
          },
          (terminationError) => {
            running--;
            reject(new DocumentImageParseError(terminationError));
            drain();
          },
        );
      };
      // Time in the queue is excluded from the worker's 30-second budget.
      task.cancel = () => finish(new Error('aborted'));
      const timer = setTimeout(
        () => finish(new Error('Document image parse exceeded 30s')),
        30_000,
      );
      worker.once('message', (message: { error?: string; result?: Result }) => {
        if (message.error || !message.result)
          finish(new Error(message.error ?? 'Document image worker returned no result'));
        else finish(undefined, message.result);
      });
      worker.once('error', (error) => finish(error));
      worker.once('exit', (code) =>
        finish(new Error(`Document image worker exited before its result (${code})`)),
      );
    };
    task.cancel = () => {
      if (removeQueued()) reject(new Error('aborted'));
    };
    const queueTimer = setTimeout(() => {
      if (removeQueued()) reject(queueFailure('Document image parse queue wait exceeded 30s'));
    }, MAX_QUEUE_WAIT_MS);
    queuedBytes += retainedBytes;
    pending.push(start);
    drain();
  });
  return task;
}

function subscribe(task: ParseTask, signal?: AbortSignal): Promise<Result> {
  task.subscribers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = () => {
      settled = true;
      signal?.removeEventListener('abort', abort);
      task.subscribers--;
    };
    const abort = () => {
      if (settled) return;
      release();
      reject(new Error('aborted'));
      if (task.subscribers === 0) {
        task.abandoned = true;
        task.cancel();
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    void task.promise.then(
      (result) => {
        if (settled) return;
        release();
        resolve(result);
      },
      (error) => {
        if (settled) return;
        release();
        reject(error);
      },
    );
    if (signal?.aborted) abort();
  });
}

export function runDocumentImageWorker(
  job: PlanJob,
  cacheKey?: string,
  signal?: AbortSignal,
): Promise<ImagePlan>;
export function runDocumentImageWorker(job: RewriteJob): Promise<RewriteResult>;
export function runDocumentImageWorker(
  job: PlanJob | RewriteJob,
  cacheKey?: string,
  signal?: AbortSignal,
): Promise<Result> {
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  const shared =
    job.kind === 'plan' && cacheKey !== undefined ? inFlightPlans.get(cacheKey) : undefined;
  if (shared && !shared.abandoned) return subscribe(shared, signal);
  let retainedBytes: number;
  try {
    retainedBytes = inputBudget(job);
  } catch (error) {
    return Promise.reject(error);
  }
  if (job.kind !== 'plan' || cacheKey === undefined)
    return subscribe(enqueue(job, retainedBytes), signal);
  const work = enqueue(job, retainedBytes);
  inFlightPlans.set(cacheKey, work);
  const remove = () => {
    if (inFlightPlans.get(cacheKey) === work) inFlightPlans.delete(cacheKey);
  };
  // Both success and failure end the in-flight entry; this is not a result cache.
  void work.promise.then(remove, remove);
  return subscribe(work, signal);
}
