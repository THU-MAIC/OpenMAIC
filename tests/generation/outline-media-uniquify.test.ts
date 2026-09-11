import { describe, expect, test } from 'vitest';

import { uniquifyMediaElementIds } from '@openmaic/generation';
import type { SceneOutline } from '@openmaic/generation';

function makeOutline(mediaGenerations?: unknown): SceneOutline {
  return {
    id: 'scene-1',
    order: 1,
    sceneType: 'slide',
    title: 'Scene',
    description: '',
    keyPoints: [],
    estimatedDuration: 60,
    ...(mediaGenerations !== undefined
      ? { mediaGenerations: mediaGenerations as SceneOutline['mediaGenerations'] }
      : {}),
  } as SceneOutline;
}

describe('uniquifyMediaElementIds', () => {
  test('assigns unique prefixed element ids to array-shaped media generations', () => {
    const outlines = [
      makeOutline([
        { type: 'image', prompt: 'a diagram' },
        { type: 'image', prompt: 'a photo' },
      ]),
      makeOutline([{ type: 'video', prompt: 'an animation' }]),
    ];

    const result = uniquifyMediaElementIds(outlines);

    const [first, second] = result.map((outline) => outline.mediaGenerations ?? []);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    const ids = [...first, ...second].map((mg) => mg.elementId);
    expect(new Set(ids).size).toBe(3);
    ids.forEach((id) => expect(id).toMatch(/^gen_(img|vid)_[A-Za-z0-9_-]{8}$/));
  });

  test('drops non-array mediaGenerations instead of throwing', () => {
    const outlines = [makeOutline('generate a diagram'), makeOutline({ type: 'image' })];

    expect(() => uniquifyMediaElementIds(outlines)).not.toThrow();

    const result = uniquifyMediaElementIds(outlines);
    result.forEach((outline) => expect(outline.mediaGenerations).toBeUndefined());
  });

  test('keeps valid arrays in mixed outlines while dropping malformed ones', () => {
    const valid = [
      { type: 'image' as const, prompt: 'a chart' },
      { type: 'video' as const, prompt: 'a clip' },
    ];
    const outlines = [makeOutline(valid), makeOutline(42), makeOutline(true)];

    const result = uniquifyMediaElementIds(outlines);

    expect(result[0].mediaGenerations).toHaveLength(2);
    expect(result[1].mediaGenerations).toBeUndefined();
    expect(result[2].mediaGenerations).toBeUndefined();
  });

  test('passes through outlines without media generations untouched', () => {
    const outlines = [makeOutline(), makeOutline([])];

    const result = uniquifyMediaElementIds(outlines);

    expect(result).toHaveLength(2);
    expect(result[0].mediaGenerations).toBeUndefined();
    expect(result[1].mediaGenerations).toEqual([]);
  });
});
