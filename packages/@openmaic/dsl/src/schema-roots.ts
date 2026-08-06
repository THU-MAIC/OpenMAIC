/**
 * Concrete schema-codegen entry point.
 *
 * JSON Schema is not generic, so the build-time generator needs a concrete,
 * non-generic root. This root explicitly composes all four contract-owned
 * content types; it adds no constraint the public generic {@link Scene} type
 * doesn't already express (the `type` <-> `content` binding lives in `Scene`
 * itself). It is intentionally NOT re-exported from `index.ts`.
 *
 * We spell the union out explicitly rather than writing a generic composition,
 * because the schema generator collapses
 * the bare form into a single object with an unbound `type`, whereas the
 * spelled-out union emits a discriminated `anyOf` that preserves the binding.
 *
 * Scope: `scene.schema.json` covers all four persisted content kinds owned by
 * the contract while preserving their scene `type` ↔ `content.type` binding.
 */
import type { Scene, SlideContent, QuizContent } from './stage.js';
import type { InteractiveContent } from './interactive.js';
import type { PBLContent } from './pbl.js';
import type { Action } from './action.js';

export type SerializedScene =
  | Scene<Action, SlideContent>
  | Scene<Action, QuizContent>
  | Scene<Action, InteractiveContent>
  | Scene<Action, PBLContent>;
