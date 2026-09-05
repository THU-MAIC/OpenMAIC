import { nanoid } from 'nanoid';
import type { SceneOutline } from './outline-types.js';

/** Give every generated-media request its own globally unique ID. */
export function uniquifyMediaElementIds(outlines: SceneOutline[]): SceneOutline[] {
  if (!outlines.some((outline) => outline.mediaGenerations?.length)) return outlines;

  return outlines.map((outline) => {
    if (!outline.mediaGenerations) return outline;
    return {
      ...outline,
      mediaGenerations: outline.mediaGenerations.map((mediaGeneration) => {
        const prefix = mediaGeneration.type === 'video' ? 'gen_vid_' : 'gen_img_';
        return { ...mediaGeneration, elementId: `${prefix}${nanoid(8)}` };
      }),
    };
  });
}
