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
 * the video (done) or the error state (failed) automatically. The server
 * already patched the persisted document on success, so the server-relative
 * src doubles as the task's renderable URL — it works as-is in the browser.
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
