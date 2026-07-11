import { describe, expect, it } from 'vitest';
import { transformParsedToSlides } from '../src/import-pipeline/transformParsedToSlides';
import { createMockImportContext } from '../src/import-pipeline/mockContext';

describe('transformParsedToSlides · text frame geometry', () => {
  it('does not clamp overflowing width for quarter-turn spAutoFit text', async () => {
    const json = {
      size: { width: 960, height: 540 },
      themeColors: [],
      slides: [
        {
          fill: { type: 'color', value: '#ffffff' },
          note: '',
          layoutElements: [],
          elements: [
            {
              type: 'text',
              left: 850.4175,
              top: 398.49,
              width: 194.204,
              height: 16.964,
              name: '文本框 10',
              order: 1,
              rotate: 270,
              content:
                '<div style="padding: 0px;"><p style="white-space: nowrap"><span>Copyright © 元知进化Cog Evol. All Rights Reserved</span></p></div>',
              fill: { type: 'color', value: 'transparent' },
              borderWidth: 0,
              borderColor: '#000000',
              borderType: 'solid',
              borderStrokeDasharray: '0',
              isVertical: false,
              vAlign: 'up',
              autoFit: { type: 'shape' },
            },
          ],
        },
      ],
    };

    const { slides } = await transformParsedToSlides(
      json as unknown as Parameters<typeof transformParsedToSlides>[0],
      createMockImportContext({ viewportWidth: 1280 }),
    );

    const [text] = slides[0].elements;

    expect(text.type).toBe('text');
    expect(text.left).toBeCloseTo(1133.89, 2);
    expect(text.width).toBeCloseTo(258.94, 2);
    expect(text.left + text.width).toBeGreaterThan(slides[0].viewportSize);
  });
});
