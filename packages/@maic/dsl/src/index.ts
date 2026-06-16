/**
 * @maic/dsl — the pure, dependency-free contract keystone for the MAIC SDK family.
 *
 * Dependency arrows (kept acyclic):
 *   @maic/dsl       -> (nothing)
 *   @maic/renderer  -> @maic/dsl
 *   @maic/importer  -> @maic/dsl
 *   @maic/exporter  -> @maic/dsl   (reserved, future)
 *
 * This package contains ONLY the spec: types, (future) JSON Schema, pure
 * validators / type-guards, and version/migration helpers. It must never gain
 * a runtime dependency on React, pptx, echarts, etc.
 *
 * The lesson skeleton (`Stage` / `Scene` / `SceneContent`) lives here. `Scene`
 * is generic: the contract owns only the universal structure + the slide/quiz
 * content kinds, while playback `Action`s, Ultra-mode widgets, and PBL configs
 * are app-side feature surfaces that consumers inject via `Scene`'s type
 * parameters.
 */
export * from './slides.js';
export * from './guards.js';
export * from './stage.js';
export * from './version.js';
