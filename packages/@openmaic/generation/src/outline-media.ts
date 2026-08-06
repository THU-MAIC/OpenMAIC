import { nanoid } from 'nanoid';
import type { SceneOutline } from './outline-types.js';

/** Replace course-local generated-media IDs with globally unique IDs. */
export function uniquifyMediaElementIds(outlines: SceneOutline[]): SceneOutline[] {
  const idMap = new Map<string, string>();

  for (const outline of outlines) {
    if (!outline.mediaGenerations) continue;
    for (const mediaGeneration of outline.mediaGenerations) {
      if (!idMap.has(mediaGeneration.elementId)) {
        const prefix = mediaGeneration.type === 'video' ? 'gen_vid_' : 'gen_img_';
        idMap.set(mediaGeneration.elementId, `${prefix}${nanoid(8)}`);
      }
    }
  }

  if (idMap.size === 0) return outlines;

  return outlines.map((outline) => {
    if (!outline.mediaGenerations) return outline;
    return {
      ...outline,
      mediaGenerations: outline.mediaGenerations.map((mediaGeneration) => ({
        ...mediaGeneration,
        elementId: idMap.get(mediaGeneration.elementId) || mediaGeneration.elementId,
      })),
    };
  });
}
