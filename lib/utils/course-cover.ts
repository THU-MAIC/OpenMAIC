import type { Slide, WidgetType } from '@openmaic/dsl';

import type { Scene } from '@/lib/types/stage';

/**
 * The static cover of an interactive page: its title and widget kind, read
 * from the scene record — a picture of the page, never the page itself (the
 * live cover renders the page in a sandboxed iframe, see
 * `components/discovery/live-interactive-cover.tsx`). This is the placeholder
 * shown while a live cover has not been granted a render slot (or the page
 * has no HTML to render).
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
    readonly widgetConfig?: { readonly type?: WidgetType | null } | null;
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
      // A scene may declare its kind only through the widget's own config.
      widgetType: scene.content.widgetType ?? scene.content.widgetConfig?.type ?? null,
    };
  }
  return null;
}

/**
 * A course's cover: the first slide's canvas, or — only when the course has
 * no slide at all — its first interactive scene, rendered live. `null` at a
 * loader boundary means the course has neither.
 */
export type CourseThumbnail =
  | { readonly kind: 'slide'; readonly slide: Slide }
  | { readonly kind: 'interactive'; readonly scene: Scene };
