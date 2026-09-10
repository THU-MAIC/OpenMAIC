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
