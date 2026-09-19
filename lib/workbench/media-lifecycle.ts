/**
 * Client fold of the `media_ready` lifecycle event.
 *
 * The agent's async media tools (generate_video) return a `gen_vid_<id>`
 * placeholder immediately and settle in a detached background job — possibly
 * after the run ended. When the job settles, the server appends `media_ready`
 * to the durable session log; this module folds that frame into the media
 * generation store keyed by the placeholder ref, so `lookupMediaTask` /
 * `resolveVideoMediaForElement` (lib/media/media-task-resolution.ts) resolve
 * the element still carrying the placeholder and its skeleton transitions to
 * the video (done) or the error state (failed) automatically.
 *
 * A done frame's `src` is the id the asset pool allocated, not a URL: the tools
 * store their bytes in the pool and the server's completion patch writes that
 * id onto the element (#1522). So `objectUrl` carries an IDENTITY here, which
 * `lookupMediaTask` already allows for ("tasks that were re-keyed to an
 * allocated id"), and the bytes come from leasing it: `useResolvedMediaRef`
 * leases a pool id found on the task whenever the document's own reference is
 * not leasable yet (`lib/media/resolve-media-ref.ts`), which is exactly this
 * window — the element still holds the placeholder until the stage-freshness
 * sync brings the patched scene in. The video therefore plays when the frame
 * arrives, not when the sync lands.
 *
 * The lease is taken at the render boundary rather than here on purpose. A URL
 * minted in this fold would be a shared pool snapshot stored in a field the
 * media store revokes on its own schedule (`revokeObjectUrls`, `clearStage`),
 * which would tear a URL other mounted surfaces are still using; and replaying
 * a session's frames would pin one blob per completed video for the session.
 * `use-asset-url` owns URL lifetimes, and it releases them on unmount.
 */
import type { MediaReadyLifecycleData } from '@/lib/agent-runtime/lifecycle';
import { useMediaGenerationStore, type MediaTask } from '@/lib/store/media-generation';

/** Validate a `media_ready` frame's payload; null when malformed. */
export function parseMediaReadyFrame(data: unknown): MediaReadyLifecycleData | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const source = data as Record<string, unknown>;
  if (typeof source.ref !== 'string' || typeof source.stageId !== 'string') return null;
  if (source.status !== 'done' && source.status !== 'failed') return null;
  // A done frame without its src is useless — the ref would stay a skeleton.
  if (source.status === 'done' && typeof source.src !== 'string') return null;
  return {
    ref: source.ref,
    stageId: source.stageId,
    status: source.status,
    ...(typeof source.src === 'string' ? { src: source.src } : {}),
    ...(typeof source.mime === 'string' ? { mime: source.mime } : {}),
    ...(typeof source.durationSec === 'number' ? { durationSec: source.durationSec } : {}),
    ...(typeof source.errorCode === 'string' ? { errorCode: source.errorCode } : {}),
  };
}

/** Upsert the placeholder-keyed task; an existing task (same ref) is settled, not duplicated. */
export function applyMediaReadyFrame(frame: MediaReadyLifecycleData): void {
  useMediaGenerationStore.setState((state) => {
    const existing = state.tasks[frame.ref];
    const base: MediaTask = existing ?? {
      elementId: frame.ref,
      type: 'video',
      status: 'generating',
      prompt: '',
      params: {},
      retryCount: 0,
      stageId: frame.stageId,
    };
    const next: MediaTask =
      frame.status === 'done'
        ? {
            ...base,
            status: 'done',
            objectUrl: frame.src,
            params: frame.durationSec
              ? { ...base.params, duration: frame.durationSec }
              : base.params,
            error: undefined,
            errorCode: undefined,
          }
        : {
            ...base,
            status: 'failed',
            error: existing?.error ?? 'media generation failed',
            errorCode: frame.errorCode,
          };
    return { tasks: { ...state.tasks, [frame.ref]: next } };
  });
}
