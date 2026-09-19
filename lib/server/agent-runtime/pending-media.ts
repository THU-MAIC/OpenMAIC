/**
 * In-process registry of detached media-generation jobs started by the agent
 * media tools (`generate_video`; `generate_image` is a planned follow-up).
 *
 * The tool call returns immediately with a `gen_vid_<id>` placeholder and the
 * provider submit → poll → download → persist cycle runs detached; this map is
 * the server's local view of those jobs, keyed by the placeholder ref, for
 * diagnostics and tests.
 *
 * V1 LIMITATION, accepted on purpose: the registry is process-local and holds
 * no recovery information. A restart loses every pending entry — the provider
 * job may still be running and billing, but nothing will patch the document or
 * emit `media_ready` for it, so a placeholder element keeps rendering its
 * skeleton until the media is regenerated. Durable provider task ids and a
 * crash-recovery sweep are deliberately out of scope for v1.
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('AgentPendingMedia');

export type PendingMediaStatus = 'generating' | 'done' | 'failed';

/** Coarse progress marker inside the provider/persist cycle. */
export type PendingMediaStage = 'submit' | 'persist' | 'patch';

export interface PendingMediaTask {
  /** The `gen_vid_<id>` placeholder the tool returned. */
  ref: string;
  type: 'video';
  stageId: string;
  sessionId?: string;
  provider?: string;
  status: PendingMediaStatus;
  stage?: PendingMediaStage;
  /** Server-relative src once persisted. */
  src?: string;
  mime?: string;
  errorCode?: string;
  startedAt: number;
  settledAt?: number;
}

const tasks = new Map<string, PendingMediaTask>();

/** Register a freshly minted placeholder. A duplicate ref keeps the first entry. */
export function registerPendingMedia(
  task: Pick<PendingMediaTask, 'ref' | 'type' | 'stageId'> &
    Partial<Omit<PendingMediaTask, 'ref' | 'type' | 'stageId' | 'status' | 'startedAt'>>,
): PendingMediaTask {
  const existing = tasks.get(task.ref);
  if (existing) {
    log.warn(`pending media ref ${task.ref} already registered; keeping the first entry`);
    return existing;
  }
  // Registration is the natural sweep point: settled entries have already
  // emitted their `media_ready` frame, so dropping them here keeps the map
  // bounded to in-flight work plus the completions since the last call.
  pruneSettledPendingMedia();
  const entry: PendingMediaTask = {
    ...task,
    status: 'generating',
    startedAt: Date.now(),
  };
  tasks.set(task.ref, entry);
  return entry;
}

/** Advance the coarse progress marker of a pending task. Unknown refs are ignored. */
export function setPendingMediaStage(ref: string, stage: PendingMediaStage): void {
  const task = tasks.get(ref);
  if (!task || task.status !== 'generating') return;
  task.stage = stage;
}

export type PendingMediaOutcome =
  | { status: 'done'; src: string; mime?: string }
  | { status: 'failed'; errorCode: string };

/** Settle a pending task terminally. Unknown refs are ignored. */
export function settlePendingMedia(ref: string, outcome: PendingMediaOutcome): void {
  const task = tasks.get(ref);
  if (!task || task.status !== 'generating') return;
  task.status = outcome.status;
  task.settledAt = Date.now();
  if (outcome.status === 'done') {
    task.src = outcome.src;
    task.mime = outcome.mime;
  } else {
    task.errorCode = outcome.errorCode;
  }
}

/** Test/diagnostic query seam. */
export function getPendingMediaTask(ref: string): PendingMediaTask | undefined {
  return tasks.get(ref);
}

/** Snapshot of every known task, in registration order. */
export function listPendingMediaTasks(): PendingMediaTask[] {
  return [...tasks.values()].map((task) => ({ ...task }));
}

/** Drop settled entries; pending ones stay. Returns the number removed. */
export function pruneSettledPendingMedia(): number {
  let removed = 0;
  for (const [ref, task] of tasks) {
    if (task.status !== 'generating') {
      tasks.delete(ref);
      removed += 1;
    }
  }
  return removed;
}

/** Test-only reset. */
export function clearPendingMediaTasks(): void {
  tasks.clear();
}
