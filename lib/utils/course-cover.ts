import type { Slide, WidgetType } from '@openmaic/dsl';

/**
 * The static cover of an interactive page: its title and widget kind, read
 * from the scene record — a picture of the page, never the page itself (its
 * HTML is not run, see `components/discovery/interactive-cover.tsx`).
 */
export interface InteractiveCoverData {
  /** The interactive scene's title, trimmed; may be empty. */
  readonly title: string;
  /** The interactive scene's widget kind, when it declares one. */
  readonly widgetType: WidgetType | null;
}

/** The scene shape {@link firstInteractiveCover} reads. */
interface InteractiveCoverScene {
  readonly title?: string | null;
  readonly content?: {
    readonly type?: string;
    readonly widgetType?: WidgetType | null;
  } | null;
}

/**
 * The cover data of a course's first interactive scene, or null when the
 * course has no interactive scene.
 *
 * Deliberately structural — an app `Scene` and a raw persisted scene record
 * both fit — so client loaders and server-side pickers can share one
 * selection rule instead of re-deriving "first interactive" per surface.
 */
export function firstInteractiveCover(
  scenes: readonly InteractiveCoverScene[],
): InteractiveCoverData | null {
  for (const scene of scenes) {
    if (scene.content?.type !== 'interactive') continue;
    return {
      title: (scene.title ?? '').trim(),
      widgetType: scene.content.widgetType ?? null,
    };
  }
  return null;
}

/**
 * A course's cover: the first slide's canvas, or — only when the course has
 * no slide at all — the static cover of its first interactive page. `null` at
 * a loader boundary means the course has neither.
 */
export type CourseThumbnail =
  | { readonly kind: 'slide'; readonly slide: Slide }
  | { readonly kind: 'interactive'; readonly cover: InteractiveCoverData };
