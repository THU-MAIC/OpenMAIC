/**
 * @openmaic/dsl — the pure, dependency-free contract keystone for the MAIC SDK family.
 *
 * Dependency arrows (kept acyclic):
 *   @openmaic/dsl       -> (nothing)
 *   @openmaic/renderer  -> @openmaic/dsl
 *   @openmaic/importer  -> @openmaic/dsl
 *   @openmaic/exporter  -> @openmaic/dsl   (reserved, future)
 *
 * This package contains ONLY the spec: types, JSON Schema artifacts, pure
 * validators / type-guards, pure `normalize*` defaulters, and version/migration
 * helpers. It must never gain a runtime dependency on React, pptx, echarts, etc.
 * The JSON Schema is generated at build time (devDependency only) and shipped
 * under `@openmaic/dsl/schema/*`; the pure `validate*` / `normalize*` functions
 * stay zero-dep. `validate*` reports on a document; `normalize*` repairs one
 * (fills required-field defaults, derives geometry, fails loud on malformed
 * input) so the result satisfies the validators.
 *
 * The lesson skeleton (`Stage` / `Scene` / `SceneContent`) and the playback
 * verb set (`Action` and its variants) both live here. `Scene` is generic: the
 * contract owns the universal structure, the slide/quiz content kinds, and the
 * standard `Action` union (which `TAction` now defaults to). PBL configs and
 * the app's richer content kinds remain app-side feature surfaces that
 * consumers inject via `Scene`'s type parameters.
 */
export * from './slides.js';
export * from './guards.js';
export * from './stage.js';
export * from './action.js';
export * from './validate.js';
export * from './normalize.js';
export * from './version.js';
export * from './storage.js';
