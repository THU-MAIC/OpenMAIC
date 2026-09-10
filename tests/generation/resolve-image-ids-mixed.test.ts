import { describe, expect, test } from 'vitest';

import { resolveImageIds } from '@openmaic/generation';
import type { GeneratedSlideData } from '@openmaic/generation';

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

/**
 * Per-source byte fallback (RFC #1153 part 2, N4): a server-backed run can
 * yield a mapping that MIXES allocated asset ids (sources whose cache write
 * succeeded) and IndexedDB data URLs (sources whose cache write failed and
 * materialized their own bytes). `resolveImageIds` is shape-based — each
 * mapping value is written verbatim — so both transports must ride the same
 * mapping without a mode flag.
 */
describe('resolveImageIds — mixed asset-id / data-URL mapping (N4)', () => {
  test('writes the allocated id and the data URL verbatim from one mapping', () => {
    const dataUrl = 'data:image/png;base64,AQID';
    const resolved = resolveImageIds([imageElement('img_1'), imageElement('img_2')], {
      img_1: 'ast_allocated_image_0001',
      img_2: dataUrl,
    });

    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toMatchObject({ type: 'image', src: 'ast_allocated_image_0001' });
    expect(resolved[1]).toMatchObject({ type: 'image', src: dataUrl });
  });

  test('drops only the image whose id has NO mapping entry in a mixed mapping', () => {
    const resolved = resolveImageIds(
      [imageElement('img_1'), imageElement('img_2'), imageElement('img_9')],
      {
        img_1: 'ast_allocated_image_0001',
        img_2: 'data:image/png;base64,AQID',
      },
    );

    expect(resolved).toHaveLength(2);
    expect(resolved.map((el) => (el.type === 'image' ? el.src : undefined))).toEqual([
      'ast_allocated_image_0001',
      'data:image/png;base64,AQID',
    ]);
  });
});
