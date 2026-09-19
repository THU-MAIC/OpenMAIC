/**
 * SlideContent schema versioning. Slide-surface PRs will iterate the
 * on-disk shape; this module is the single chokepoint for normalizing
 * any incoming SlideContent (API response, snapshot restore, future
 * localStorage restore, PPTX reimport) to the current version.
 *
 * Conventions:
 *   - `migrateSlideContent` is pure (returns a new reference only when
 *     it has to change something) and idempotent (running it twice is
 *     identical to running it once).
 *   - Each schema bump appends a step keyed by the previous version's
 *     number. v1 (current) needs no per-step migration body — just the
 *     guarantee that the field is present.
 */

import {
  makeScene,
  type InteractiveContent,
  type Scene,
  type SceneContent,
  type SlideContent,
} from '@/lib/types/stage';

export const CURRENT_SLIDE_CONTENT_SCHEMA_VERSION = 1;

export function migrateSlideContent(content: SlideContent): SlideContent {
  // Forward-compatibility: if a future client has written content with a
  // newer schemaVersion than we know about, return it untouched rather
  // than silently downgrading. The slide may not render correctly here,
  // but its on-disk shape stays intact for the next compatible client.
  if (
    content.schemaVersion !== undefined &&
    content.schemaVersion >= CURRENT_SLIDE_CONTENT_SCHEMA_VERSION
  ) {
    return content;
  }
  // Legacy data (no schemaVersion) and any older intermediate versions
  // fall through here. As schema versions accumulate, walk versions in
  // order and apply each step's body before stamping the final version.
  return {
    ...content,
    schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
  };
}

/**
 * InteractiveContent migration. The legacy widget-actions pipeline persisted a
 * `teacherActions` authoring layer alongside the materialized `actions` stream;
 * that field is now dead (playback reads only `scene.actions`). Legacy documents
 * carry it in two places — at the top level and nested inside `widgetConfig`
 * (every WidgetConfig variant used to declare it) — so drop both on load. Pure +
 * idempotent: returns the same reference when there's nothing to drop. No
 * schemaVersion is needed yet — the sole change is removing an inert field,
 * which is naturally idempotent.
 */
export function migrateInteractiveContent(content: InteractiveContent): InteractiveContent {
  const legacy = content as InteractiveContent & {
    teacherActions?: unknown;
    widgetConfig?: Record<string, unknown> & { teacherActions?: unknown };
  };
  const hasTop = 'teacherActions' in legacy;
  const hasNested = legacy.widgetConfig != null && 'teacherActions' in legacy.widgetConfig;
  if (!hasTop && !hasNested) {
    return content;
  }
  const { teacherActions: _top, widgetConfig, ...rest } = legacy;
  const next = rest as InteractiveContent & { widgetConfig?: Record<string, unknown> };
  if (widgetConfig !== undefined) {
    if (hasNested) {
      const { teacherActions: _nested, ...widgetRest } = widgetConfig;
      next.widgetConfig = widgetRest;
    } else {
      next.widgetConfig = widgetConfig;
    }
  }
  return next;
}

/**
 * Top-level scene migrator — dispatches by scene-content type. SlideContent is
 * versioned; InteractiveContent drops its legacy `teacherActions` field; other
 * content types pass through. Future surfaces declare their own migrators and
 * wire them in here.
 */
export function migrateScene(scene: Scene): Scene {
  const migratedContent = migrateSceneContent(scene.content);
  if (migratedContent === scene.content) {
    return scene;
  }
  return makeScene(scene, migratedContent);
}

function migrateSceneContent(content: SceneContent): SceneContent {
  if (content.type === 'slide') {
    return migrateSlideContent(content);
  }
  if (content.type === 'interactive') {
    return migrateInteractiveContent(content);
  }
  return content;
}
