import { describe, expect, test, vi } from 'vitest';

import { generateSceneContent, resolveImageIds } from '@openmaic/generation';
import type { GeneratedSlideData, PdfImage } from '@openmaic/generation';

import { slideOutline } from './scene-fixtures.js';

function imageElement(src: string): GeneratedSlideData['elements'][number] {
  return {
    id: 'el_1',
    type: 'image',
    src,
    left: 0,
    top: 0,
    width: 400,
    height: 300,
    rotate: 0,
    fixedRatio: false,
  };
}

describe('resolveImageIds — transport decided by the mapping value shape (RFC #1153 part 2 B)', () => {
  test('writes the allocated asset id into src when the mapping value is an asset id', () => {
    const resolved = resolveImageIds([imageElement('img_1')], {
      img_1: 'ast_allocated_image_0001',
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ type: 'image', src: 'ast_allocated_image_0001' });
  });

  test('writes the base64 data URL into src when the mapping value is a data URL', () => {
    const dataUrl = 'data:image/png;base64,AQID';
    const resolved = resolveImageIds([imageElement('img_1')], { img_1: dataUrl });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ type: 'image', src: dataUrl });
  });

  test('removes an image whose id has no mapping entry, in both transports', () => {
    const resolved = resolveImageIds([imageElement('img_9')], { img_1: 'ast_something' });
    expect(resolved).toHaveLength(0);
  });

  test('leaves generated-media placeholders untouched (async backfill path)', () => {
    const resolved = resolveImageIds([imageElement('gen_img_alpha_001')], {
      img_1: 'ast_something',
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ type: 'image', src: 'gen_img_alpha_001' });
  });
});

describe('generateSceneContent — non-vision text ordering with a mapping present (RFC #1153 part 2, review P3)', () => {
  test('visionEnabled off + imageMapping present lists images in the ORIGINAL sorted order, not slices-concatenated', async () => {
    // Fixture where the full vision-priority interleave ≠ mapped-then-unmapped
    // concat: img_1 and img_3 carry a mapping entry, img_2 and img_4 do not,
    // and they INTERLEAVE in the sort (priority desc, then pageNumber asc).
    // Concatenating [mapped, unmapped] would yield img_1, img_3, img_2, img_4;
    // the pre-partition `sortedAssignedImages` order is the interleave
    // img_1, img_2, img_3, img_4 — which the non-vision text must restore.
    const assignedImages: PdfImage[] = [
      { id: 'img_1', src: '', pageNumber: 1, visionPriority: 2 },
      { id: 'img_2', src: '', pageNumber: 2, visionPriority: 1 },
      { id: 'img_3', src: '', pageNumber: 3, visionPriority: 1 },
      { id: 'img_4', src: '', pageNumber: 4, visionPriority: 0 },
    ];
    const imageMapping = { img_1: 'ast_1', img_3: 'ast_3' };
    let userPrompt = '';
    const aiCall = vi.fn(async (_system: string, user: string) => {
      userPrompt = user;
      return JSON.stringify({ elements: [], remark: '' });
    });

    await generateSceneContent(slideOutline(), aiCall, {
      assignedImages,
      imageMapping,
      visionEnabled: false,
    });

    const availableMedia = userPrompt.split('- **Available Media**:')[1] ?? '';
    const ids = [...availableMedia.matchAll(/\*\*(img_\d+)\*\*/g)].map((match) => match[1]);
    expect(ids).toEqual(['img_1', 'img_2', 'img_3', 'img_4']);
    // No `[see attached]` promise in the non-vision text.
    expect(availableMedia).not.toContain('[see attached]');
  });
});

async function generatePdfImage(
  overrides: Record<string, unknown>,
  dimensions: Partial<Pick<PdfImage, 'width' | 'height'>> = {},
) {
  const content = await generateSceneContent(
    slideOutline(),
    async () =>
      JSON.stringify({
        elements: [
          {
            id: 'el_1',
            type: 'image',
            src: 'img_1',
            left: 100,
            top: 100,
            width: 400,
            height: 200,
            rotate: 0,
            fixedRatio: true,
            ...overrides,
          },
        ],
      }),
    {
      assignedImages: [{ id: 'img_1', src: '', pageNumber: 1, ...dimensions }],
      imageMapping: { img_1: 'ast_1' },
    },
  );

  if (!content || !('elements' in content) || content.elements.length !== 1) {
    throw new Error('expected one generated image element');
  }
  const image = content.elements[0];
  if (image.type !== 'image') {
    throw new Error('expected an image element');
  }
  return image;
}

describe('generateSceneContent — PDF image containment', () => {
  test('scales wide PDF images to the horizontal safe area', async () => {
    const image = await generatePdfImage(
      { left: 100, top: 80, width: 1200, height: 400 },
      { width: 1200, height: 400 },
    );

    expect(image).toMatchObject({ left: 50, top: 80, width: 900, height: 300 });
    expect(image.left + image.width).toBeLessThanOrEqual(950);
  });

  test('moves offset PDF images back inside the safe area', async () => {
    const image = await generatePdfImage(
      { left: 700, top: 520, width: 400, height: 300 },
      { width: 800, height: 400 },
    );

    expect(image).toMatchObject({ left: 550, top: 312.5, width: 400, height: 200 });
    expect(image.left).toBeGreaterThanOrEqual(50);
    expect(image.top).toBeGreaterThanOrEqual(50);
  });

  test('caps tall PDF images at the vertical safe-area height', async () => {
    const image = await generatePdfImage(
      { left: 100, top: 100, width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    );

    expect(image).toMatchObject({ width: 462.5, height: 462.5 });
    expect(image.left + image.width).toBeLessThanOrEqual(950);
    expect(image.top + image.height).toBeLessThanOrEqual(512.5);
  });

  test('contains assigned images when source dimensions are unavailable', async () => {
    const image = await generatePdfImage({ left: 0, top: 0, width: 1200, height: 400 }, {});

    expect(image).toMatchObject({ left: 50, top: 50, width: 900, height: 300 });
  });

  test('keeps extreme aspect ratios positive in both directions', async () => {
    const wideImage = await generatePdfImage(
      { left: 100, top: 100, width: 400, height: 200 },
      { width: 10000, height: 10 },
    );
    const tallImage = await generatePdfImage(
      { left: 100, top: 100, width: 400, height: 200 },
      { width: 10, height: 10000 },
    );

    expect(wideImage.width).toBe(400);
    expect(wideImage.height).toBeCloseTo(0.4);
    expect(wideImage.height).toBeGreaterThan(0);
    expect(tallImage.width).toBeCloseTo(0.4625);
    expect(tallImage.height).toBeCloseTo(462.5);
    expect(tallImage.width).toBeGreaterThan(0);
    expect(tallImage.height).toBeGreaterThan(0);
  });

  test('sanitizes non-finite generated geometry', async () => {
    const content = await generateSceneContent(
      slideOutline(),
      async () =>
        '{"elements":[{"id":"el_1","type":"image","src":"img_1","left":100,"top":100,"width":1e309,"height":1e309,"rotate":0,"fixedRatio":true}]}',
      {
        assignedImages: [{ id: 'img_1', src: '', pageNumber: 1, width: 2, height: 1 }],
        imageMapping: { img_1: 'ast_1' },
      },
    );

    if (!content || !('elements' in content) || content.elements[0]?.type !== 'image') {
      throw new Error('expected a finite image element');
    }
    expect(Number.isFinite(content.elements[0].left)).toBe(true);
    expect(Number.isFinite(content.elements[0].top)).toBe(true);
    expect(Number.isFinite(content.elements[0].width)).toBe(true);
    expect(Number.isFinite(content.elements[0].height)).toBe(true);
    expect(content.elements[0].width).toBeGreaterThan(0);
    expect(content.elements[0].height).toBeGreaterThan(0);
    expect(content.elements[0].left).toBeGreaterThanOrEqual(50);
    expect(content.elements[0].top).toBeGreaterThanOrEqual(50);
    expect(content.elements[0].left + content.elements[0].width).toBeLessThanOrEqual(950);
    expect(content.elements[0].top + content.elements[0].height).toBeLessThanOrEqual(512.5);
  });
});
