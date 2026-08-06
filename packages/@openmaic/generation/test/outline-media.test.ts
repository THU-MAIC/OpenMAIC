// Behavior-parity coverage for uniquifyMediaElementIds from lib/generation/scene-builder.ts.
import { describe, expect, test } from 'vitest';
import { uniquifyMediaElementIds, type SceneOutline } from '@openmaic/generation';

describe('uniquifyMediaElementIds', () => {
  test('replaces colliding generated IDs consistently without mutating the input', () => {
    const outlines: SceneOutline[] = [1, 2].map((order) => ({
      id: `scene_${order}`,
      type: 'slide',
      title: `Scene ${order}`,
      description: 'Description',
      keyPoints: [],
      order,
      mediaGenerations: [
        { type: 'image', prompt: 'A diagram', elementId: 'gen_img_1' },
        { type: 'video', prompt: 'A clip', elementId: `custom_${order}` },
      ],
    }));

    const result = uniquifyMediaElementIds(outlines);
    const firstId = result[0]?.mediaGenerations?.[0]?.elementId;

    expect(firstId).toMatch(/^gen_img_[A-Za-z0-9_-]{8}$/);
    expect(result[1]?.mediaGenerations?.[0]?.elementId).toBe(firstId);
    expect(result[0]?.mediaGenerations?.[1]?.elementId).toMatch(/^gen_vid_[A-Za-z0-9_-]{8}$/);
    expect(outlines[0]?.mediaGenerations?.[0]?.elementId).toBe('gen_img_1');
  });

  test('returns the original array when no media IDs exist', () => {
    const outlines: SceneOutline[] = [
      {
        id: 'scene',
        type: 'slide',
        title: 'Scene',
        description: 'Description',
        keyPoints: [],
        order: 1,
      },
    ];
    expect(uniquifyMediaElementIds(outlines)).toBe(outlines);
  });
});
