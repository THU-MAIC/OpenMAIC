/**
 * `buildImageResources` — feeds existing slide images to the slide generator as
 * RESOURCES (the same `assignedImages` + `imageMapping` channel as
 * course-generation) instead of trying to preserve them across the round-trip
 * (which can't work — the generator re-mints every element id). Each real image
 * src becomes `img_N` in `imageMapping`, is described in `assignedImages`, and
 * the returned baseline carries the small id-ref instead of the payload.
 */
import { describe, expect, it } from 'vitest';

import { buildImageResources } from '@/lib/agent/tools/regenerate-scene';
import type { GeneratedSlideContent } from '@/lib/types/generation';
import type { PPTElement } from '@openmaic/dsl';

function img(id: string, src: string): PPTElement {
  return {
    id,
    type: 'image',
    left: 0,
    top: 0,
    width: 120,
    height: 80,
    src,
    fixedRatio: true,
    rotate: 0,
  } as unknown as PPTElement;
}

function txt(id: string, content: string): PPTElement {
  return {
    id,
    type: 'text',
    left: 0,
    top: 0,
    width: 100,
    height: 40,
    content,
    defaultFontName: '',
    defaultColor: '#000',
    rotate: 0,
  } as unknown as PPTElement;
}

describe('buildImageResources', () => {
  it('lifts a data: image src into resources and rewrites the baseline to an id-ref', () => {
    const real = 'data:image/png;base64,AAAA';
    const baseline: GeneratedSlideContent = { elements: [img('image_x', real)] };

    const out = buildImageResources(baseline);

    // Baseline element src rewritten to the small img_N reference (no base64).
    expect((out.baseline.elements[0] as { src: string }).src).toBe('img_1');
    // Resource channel carries the real src + dimensions + a description.
    expect(out.imageMapping).toEqual({ img_1: real });
    expect(out.assignedImages).toHaveLength(1);
    expect(out.assignedImages[0]).toMatchObject({
      id: 'img_1',
      src: real,
      pageNumber: 0,
      width: 120,
      height: 80,
      description: 'Existing slide image',
    });
  });

  it('lifts an http(s) image src too', () => {
    const real = 'https://cdn.example.com/a.png';
    const baseline: GeneratedSlideContent = { elements: [img('image_y', real)] };

    const out = buildImageResources(baseline);

    expect((out.baseline.elements[0] as { src: string }).src).toBe('img_1');
    expect(out.imageMapping).toEqual({ img_1: real });
  });

  it('assigns distinct ids to multiple images and leaves non-image elements untouched', () => {
    const baseline: GeneratedSlideContent = {
      elements: [
        img('image_1', 'data:image/png;base64,AAAA'),
        txt('text_1', '<p>hi</p>'),
        img('image_2', 'https://cdn.example.com/b.png'),
      ],
    };

    const out = buildImageResources(baseline);

    expect((out.baseline.elements[0] as { src: string }).src).toBe('img_1');
    // Non-image element passes through verbatim.
    expect(out.baseline.elements[1]).toBe(baseline.elements[1]);
    expect((out.baseline.elements[2] as { src: string }).src).toBe('img_2');
    expect(out.imageMapping).toEqual({
      img_1: 'data:image/png;base64,AAAA',
      img_2: 'https://cdn.example.com/b.png',
    });
    expect(out.assignedImages.map((i) => i.id)).toEqual(['img_1', 'img_2']);
  });

  it('leaves an already-id-ref image src untouched and produces no resource for it', () => {
    const baseline: GeneratedSlideContent = { elements: [img('image_z', 'img_3')] };

    const out = buildImageResources(baseline);

    expect((out.baseline.elements[0] as { src: string }).src).toBe('img_3');
    expect(out.assignedImages).toHaveLength(0);
    expect(out.imageMapping).toEqual({});
  });

  it('does not mutate the input baseline', () => {
    const real = 'data:image/png;base64,AAAA';
    const baseline: GeneratedSlideContent = { elements: [img('image_x', real)] };

    buildImageResources(baseline);

    expect((baseline.elements[0] as { src: string }).src).toBe(real);
  });
});
