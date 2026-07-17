/**
 * Concrete schema-codegen entry point.
 *
 * JSON Schema is not generic, so the build-time generator needs a concrete,
 * non-generic root. This is the contract's default `Scene<Action, SceneContent>`
 * — it adds no constraint the public {@link Scene} type doesn't already express
 * (the `type` <-> `content` binding lives in `Scene` itself). It is intentionally
 * NOT re-exported from `index.ts`, so it does not widen the public type surface.
 *
 * The default distributes to one member per content kind. We spell that union
 * out explicitly (`Scene<…, SlideContent> | Scene<…, QuizContent>`) rather than
 * writing `Scene<Action, SceneContent>`, because the schema generator collapses
 * the bare form into a single object with an unbound `type`, whereas the
 * spelled-out union emits a discriminated `anyOf` that preserves the binding.
 *
 * Scope: `SceneContent` is the contract-owned union (`SlideContent | QuizContent`),
 * so `scene.schema.json` covers those kinds. App-side `interactive` / `pbl`
 * content shapes are not part of the contract — apps that widen `Scene`'s
 * `TContent` own the schema for their own content shapes.
 */
import type { Scene, SlideContent, QuizContent } from './stage.js';
import type { Action } from './action.js';

export type SerializedScene = Scene<Action, SlideContent> | Scene<Action, QuizContent>;
