/**
 * `emit` pass — IR → manifest JSON.
 *
 * In this architecture slice the `VideoTimeline` IR *is* the manifest: emitting
 * is stamping the schema/version envelope and validating the result against
 * {@link VideoTimelineSchema}, so a malformed IR fails loudly here rather than
 * downstream in the (future) Hyperframes emitter. The returned object is plain,
 * JSON-serializable data — the export report and the render input in one.
 *
 * (The composition HTML / GSAP emitter is the next phase, P1d; this pass stops
 * at the manifest, as the issue scopes it.)
 *
 * Pure: validation only, no IO.
 */
import { type VideoTimeline, VideoTimelineSchema } from '../ir';

/**
 * Validate and return the IR as a manifest object. Throws (via zod) if the IR
 * does not satisfy {@link VideoTimelineSchema} — a compiler bug, since the IR is
 * assembled internally, so failing loud is correct.
 */
export function emitManifest(ir: VideoTimeline): VideoTimeline {
  return VideoTimelineSchema.parse(ir);
}

/** Serialize the manifest to a JSON string (pretty-printed by default). */
export function emitManifestJson(ir: VideoTimeline, space: number = 2): string {
  return JSON.stringify(emitManifest(ir), null, space);
}
