import { abortable } from './agent-runtime/abortable';
import { createSemaphore } from '../utils/concurrency';

/**
 * Opt-in concurrency for parallel scene-content generation (#572).
 *
 * Returns the server-configured `PARALLEL_SCENE_CONCURRENCY`, clamped to
 * [0, 10]. `0` (the default) means the client keeps the original serial
 * generation loop; a value `> 1` enables the hybrid two-phase path. Kept
 * server-side because many deployments use API keys with low per-key
 * concurrency quotas, where a bursty default would surface as 429s.
 */
export function getParallelSceneConcurrency(): number {
  const raw = Number.parseInt(process.env.PARALLEL_SCENE_CONCURRENCY ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, 10);
}

const MOSS_MAX_CONCURRENCY = 16;

/** Managed MOSS defaults to 16 concurrent requests and honors an explicit scene limit. */
export function getMossTtsConcurrency(sceneLimit = getParallelSceneConcurrency()): number {
  const raw = process.env.MOSS_TTS_CONCURRENCY?.trim();
  const requested = raw ? Number(raw) : MOSS_MAX_CONCURRENCY;
  const general = Math.max(1, sceneLimit);
  const mossLimit = Number.isInteger(requested) && requested > 0 ? requested : general;
  const hasGeneralLimit = sceneLimit > 0 || !!process.env.PARALLEL_SCENE_CONCURRENCY?.trim();
  return Math.min(mossLimit, MOSS_MAX_CONCURRENCY, hasGeneralLimit ? general : Infinity);
}

type MossGate = { semaphore: ReturnType<typeof createSemaphore>; callers: number };
// Next can bundle route modules separately. All entry points in a Node process share this registry.
const processState = globalThis as typeof globalThis & {
  openmaicMossTtsGates?: Map<string, MossGate>;
};
const gates = (processState.openmaicMossTtsGates ??= new Map<string, MossGate>());

export function runMossRequest<T>(
  baseUrl: string,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const key = new URL(baseUrl).origin;
  const gate = gates.get(key) ?? {
    semaphore: createSemaphore(getMossTtsConcurrency()),
    callers: 0,
  };
  gates.set(key, gate);
  gate.callers++;
  const queued = gate.semaphore
    .run(async () => {
      signal.throwIfAborted();
      return work();
    })
    .finally(() => {
      if (--gate.callers === 0) gates.delete(key);
    });
  return abortable(queued, signal);
}
