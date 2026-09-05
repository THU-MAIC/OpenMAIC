import { beforeEach, describe, expect, test, vi } from 'vitest';
import { uniquifyMediaElementIds, type SceneOutline } from '@openmaic/generation';

const nanoid = vi.hoisted(() => vi.fn());

vi.mock('nanoid', () => ({ nanoid }));

describe('uniquifyMediaElementIds', () => {
  beforeEach(() => {
    let sequence = 0;
    nanoid.mockImplementation(() => String(++sequence).padStart(8, '0'));
  });

  test('assigns every generation request a globally unique ID without mutating the input', () => {
    const outlines: SceneOutline[] = [1, 2].map((order) => ({
      id: `scene_${order}`,
      type: 'slide',
      title: `Scene ${order}`,
      description: 'Description',
      keyPoints: [],
      order,
      mediaGenerations: [
        { type: 'image', prompt: `Diagram ${order}`, elementId: 'gen_img_1' },
        { type: 'video', prompt: `Clip ${order}`, elementId: `custom_${order}` },
      ],
    }));

    const result = uniquifyMediaElementIds(outlines);
    const resultIds = result.flatMap((outline) =>
      (outline.mediaGenerations ?? []).map((request) => request.elementId),
    );

    expect(resultIds).toEqual([
      'gen_img_00000001',
      'gen_vid_00000002',
      'gen_img_00000003',
      'gen_vid_00000004',
    ]);
    expect(new Set(resultIds).size).toBe(resultIds.length);
    expect(
      outlines.flatMap((outline) =>
        (outline.mediaGenerations ?? []).map((request) => request.elementId),
      ),
    ).toEqual(['gen_img_1', 'custom_1', 'gen_img_1', 'custom_2']);
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
