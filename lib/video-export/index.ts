/**
 * `lib/video-export` — the classroom-video compiler (issue #864).
 *
 * The compiler turns classroom data into a `VideoTimeline` **IR** with pure
 * passes — the system contract for video export (#854). It is produced and
 * inspected without FFmpeg / Chrome; live app state enters only through the
 * injected {@link TimingProbe} / {@link AssetSource}. The Hyperframes composition
 * is a downstream consumer of the IR, added in a later phase.
 *
 * Purity is machine-enforced by an eslint boundary on `lib/video-export/**`
 * (allows only `@openmaic/dsl`, `zod`, in-folder relatives, and the sibling
 * `lib/choreography` spec — no `@/` host paths, no React/DOM/render backend), so
 * the compiler stays interpretable in pure Node.
 *
 * @example
 *   const ir = compileVideoTimeline(
 *     { stage, scenes },
 *     { timing: myProbe, assets: mySource, config: { playbackSpeed: 1 } },
 *   );
 *   const manifest = emitManifest(ir); // validated JSON
 */
export * from './ir';
export * from './deps';
export * from './geometry';
export { compileVideoTimeline, type CompileInput, type CompileDeps } from './compile';
export { normalizeScenes, type NormalizeResult } from './passes/normalize';
export { buildTimelineOptions } from './passes/probe';
export { buildTimeline, type TimelineResult } from './passes/timeline';
export { applyGeometry, resolveEffectGeometry, type GeometryResult } from './passes/geometry';
export { planAssets, sanitizeFilenamePart, type AssetsResult } from './passes/assets';
export { emitManifest, emitManifestJson } from './passes/emit';
