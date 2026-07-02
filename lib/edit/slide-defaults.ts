import { nanoid } from 'nanoid';
import type { Slide, SlideTheme, PPTElement } from '@openmaic/dsl';
import type { Scene, SlideContent } from '@/lib/types/stage';
import type { Action } from '@/lib/types/action';
import { createElementIdMap } from '@/lib/utils/element';
import { CURRENT_SLIDE_CONTENT_SCHEMA_VERSION } from '@/lib/edit/slide-schema';

const DEFAULT_THEME: SlideTheme = {
  backgroundColor: '#ffffff',
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
  fontColor: '#333333',
  fontName: 'Microsoft YaHei',
  outline: { color: '#d14424', width: 2, style: 'solid' },
  shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
};

/**
 * Build a fresh blank slide scene for `+ Add slide` in the Pro mode rail.
 * Matches the SceneBuilder default theme so user-added slides look the
 * same as AI-generated ones until customized.
 *
 * Starts with NO actions: the playback engine dwells on a zero-action scene
 * (showing the slide for a short beat) rather than skipping it, so a fresh
 * slide is playable without seeding a meaningless empty speech clip. The empty
 * script timeline surfaces inline as a "fill me in" cue for the user / MAIC
 * Agent instead.
 */
export function createBlankSlideScene(stageId: string, title: string, order: number): Scene {
  const slide: Slide = {
    id: nanoid(),
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: DEFAULT_THEME,
    elements: [],
    background: { type: 'solid', color: '#ffffff' },
  };

  const content: SlideContent = {
    type: 'slide',
    schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
    canvas: slide,
  };

  const actions: Action[] = [];

  return {
    id: nanoid(),
    stageId,
    type: 'slide',
    title,
    order,
    content,
    actions,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Build a duplicate of an existing slide scene. Deep-clones the slide
 * payload and reassigns every element id (and group id) so React keys +
 * downstream selection state can't collide with the source slide while
 * grouped elements keep sharing a new common group id. The new scene
 * gets a fresh scene id; caller is responsible for placing it in the
 * scenes array (via `insertSceneAfter`).
 */
export function duplicateSlideScene(source: Scene, copySuffix: string, order: number): Scene {
  if (source.type !== 'slide') {
    throw new Error('duplicateSlideScene: source scene is not a slide');
  }
  const sourceContent = source.content as SlideContent;
  const { elIdMap, groupIdMap } = createElementIdMap(sourceContent.canvas.elements);
  const clonedElements: PPTElement[] = sourceContent.canvas.elements.map((element) => ({
    ...element,
    id: elIdMap[element.id],
    ...(element.groupId ? { groupId: groupIdMap[element.groupId] } : {}),
  }));

  const clonedSlide: Slide = {
    ...sourceContent.canvas,
    id: nanoid(),
    elements: clonedElements,
  };

  const content: SlideContent = {
    ...sourceContent,
    schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
    canvas: clonedSlide,
  };

  const title = copySuffix ? `${source.title} ${copySuffix}` : source.title;

  // Clone the playback actions too: reseed each action id (so the copy doesn't
  // share audio-cache keys / React keys with the source), remap element-bound
  // cues onto the cloned element ids, and drop the stale audioId so the copy
  // re-derives / regenerates its own narration audio.
  const clonedActions = source.actions?.map((action) => {
    // Deep-clone so nested cue data (chart/table/line data, points, themeColors)
    // isn't shared by reference with the source — same reason the canvas
    // elements are deep-cloned above.
    const next: Record<string, unknown> = { ...structuredClone(action), id: nanoid() };
    const elId = next.elementId;
    if (typeof elId === 'string' && elIdMap[elId]) next.elementId = elIdMap[elId];
    // Drop both audio refs — playback prefers audioUrl, so leaving it would make
    // the copy keep playing the source's server-generated TTS.
    delete next.audioId;
    delete next.audioUrl;
    return next as unknown as Action;
  });

  return {
    ...source,
    id: nanoid(),
    // A duplicate is NOT generated from the source's outline, so it must not
    // inherit `outlineId` — otherwise the editor agent would resolve the copy's
    // context to the original slide's outline. Cleared so resolveSceneOutline
    // falls back to the copy's own title / content.
    outlineId: undefined,
    title,
    order,
    content,
    actions: clonedActions,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
