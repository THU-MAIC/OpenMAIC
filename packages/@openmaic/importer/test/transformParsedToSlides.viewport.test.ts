import { describe, expect, it } from 'vitest';
import { parsedToSlides } from '../src/import-pipeline';

/**
 * The deck-size adaptation contract at the conversion boundary: the parsed
 * deck's native size (pt) drives both the emitted canvas (`viewportSize` is
 * the deck width × 96/72 px-per-pt, `viewportRatio` is height/width) and the
 * transform-time element clamp, so a 4:3 or custom deck renders on a canvas
 * that matches its real geometry instead of the 16:9 default. These fixtures
 * mirror the reference's expected geometry (16:9 default → 1280×0.5625,
 * 4:3 → 960×0.75).
 */

const deck = (size: { width: number; height: number }, elements: unknown[]) => ({
  size,
  themeColors: [],
  slides: [
    {
      fill: { type: 'color', value: '#ffffff' },
      note: '',
      layoutElements: [],
      elements,
    },
  ],
});

const textElement = (overrides: Record<string, unknown>) => ({
  type: 'text',
  left: 90,
  top: 67.5,
  width: 360,
  height: 90,
  name: 'text',
  order: 1,
  rotate: 0,
  content: '<div style="padding: 0px;"><p style="font-size: 24pt"><span>Hello</span></p></div>',
  fill: { type: 'color', value: 'transparent' },
  borderWidth: 0,
  borderColor: '#000000',
  borderType: 'solid',
  borderStrokeDasharray: '0',
  isVertical: false,
  vAlign: 'up',
  autoFit: { type: 'shape' },
  ...overrides,
});

type TextGeometry = {
  left: number;
  top: number;
  width: number;
  height: number;
  content: string;
};

describe('transformParsedToSlides · deck viewport adaptation', () => {
  it('sizes a 4:3 deck (720×540pt) to a 960×0.75 canvas and scales elements by 96/72', async () => {
    const slides = await parsedToSlides(
      deck({ width: 720, height: 540 }, [
        textElement({}),
        textElement({ left: 600, top: 400, width: 200, height: 200, name: 'edge' }),
      ]) as unknown as Parameters<typeof parsedToSlides>[0],
    );

    expect(slides).toHaveLength(1);
    const slide = slides[0];
    // 720pt × 96/72 px-per-pt → 960px wide; 540/720 → 0.75 ratio (4:3).
    expect(slide.viewportSize).toBe(960);
    expect(slide.viewportRatio).toBe(0.75);
    expect(slide.viewportSize * slide.viewportRatio).toBe(720);

    const [title, edge] = slide.elements as unknown as TextGeometry[];

    // A free-standing box scales by 96/72 with no edge clamp.
    expect(title.left).toBe(120);
    expect(title.top).toBe(90);
    expect(title.width).toBe(480);
    expect(title.height).toBe(120);
    // Inline pt sizes are scaled to px on the same 96/72 factor.
    expect(title.content).toContain('font-size: 32.0px');

    // A box hanging past the canvas edge is clamped so it fits exactly.
    expect(edge.left).toBe(800);
    expect(edge.top).toBeCloseTo(533.33, 2);
    expect(edge.width).toBe(160);
    expect(edge.height).toBeCloseTo(186.67, 2);
    expect(edge.left + edge.width).toBe(slide.viewportSize);
    expect(edge.top + edge.height).toBeCloseTo(slide.viewportSize * slide.viewportRatio, 2);
  });

  it('keeps the default 16:9 deck (960×540pt) at the reference 1280×0.5625 canvas', async () => {
    const slides = await parsedToSlides(
      deck({ width: 960, height: 540 }, [textElement({})]) as unknown as Parameters<
        typeof parsedToSlides
      >[0],
    );

    expect(slides).toHaveLength(1);
    expect(slides[0].viewportSize).toBe(1280);
    expect(slides[0].viewportRatio).toBe(0.5625);
  });

  it('handles a custom deck size generically', async () => {
    const slides = await parsedToSlides(
      deck({ width: 1000, height: 700 }, [textElement({})]) as unknown as Parameters<
        typeof parsedToSlides
      >[0],
    );

    expect(slides).toHaveLength(1);
    expect(slides[0].viewportSize).toBeCloseTo(1000 * (96 / 72), 6);
    expect(slides[0].viewportRatio).toBe(0.7);

    const [title] = slides[0].elements as unknown as TextGeometry[];
    expect(title.left).toBeCloseTo(120, 6);
    expect(title.left + title.width).toBeLessThanOrEqual(slides[0].viewportSize);
    expect(title.top + title.height).toBeLessThanOrEqual(
      slides[0].viewportSize * slides[0].viewportRatio,
    );
  });
});
