/**
 * `lib/choreography` — the shared orchestration/spec modules.
 *
 * The single source of truth for the semantics a faithful classroom-video
 * exporter needs from playback, so neither the app runtime nor the exporter
 * re-implements (and silently drifts from) the other:
 *
 * - **Timing** — playback timing constants + the deterministic no-audio speech
 *   estimate ({@link estimateSpeechDurationMs}).
 * - **Cursor** — {@link resolvePlaybackCursor}, the scene/action walk.
 * - **Timeline** — {@link resolveActionTimeline}, the index→time expansion.
 * - **Descriptors** — versioned, declarative animation descriptors
 *   ({@link DESCRIPTORS}, e.g. `spotlight.v1`) + their zod schema.
 *
 * Kept in `lib/` (not a package) because these semantics co-evolve with the
 * playback engine. Purity is machine-enforced: these modules import only
 * `@openmaic/dsl` (types + the fire-and-forget partition), `zod` (descriptor
 * schema), and pure helpers — no React / DOM / GSAP / framer-motion / render
 * backend, so the exporter can interpret them in a pure Node environment. The
 * eslint `@/`-boundary block on `lib/choreography/**` keeps host-app paths out.
 */
export * from './timing';
export * from './cursor';
export * from './timeline';
export * from './descriptors/index';
