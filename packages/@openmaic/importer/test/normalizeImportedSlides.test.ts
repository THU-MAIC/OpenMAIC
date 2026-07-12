import { describe, expect, it, vi } from 'vitest';
import { ELEMENT_DEFAULTS, type Slide } from '@openmaic/dsl';
import { normalizeImportedSlides, parsedToSlides } from '../src/import-pipeline';

const baseSlide = (elements: unknown[]): Slide =>
  ({
    id: 's1',
    elements,
    background: { type: 'solid', color: '#ffffff' },
    viewportSize: 1280,
    viewportRatio: 0.5625,
  }) as unknown as Slide;

const box = { id: 'e1', left: 10, top: 10, width: 100, height: 50, rotate: 0 };

describe('normalizeImportedSlides', () => {
  it('fills required content fields the transform left off', () => {
    const [slide] = normalizeImportedSlides([
      baseSlide([{ ...box, type: 'text', content: '<p>hi</p>' }]),
    ]);
    const [text] = slide.elements;
    expect(text.type).toBe('text');
    expect(text).toMatchObject({
      defaultFontName: ELEMENT_DEFAULTS.text.defaultFontName,
      defaultColor: ELEMENT_DEFAULTS.text.defaultColor,
    });
  });

  it("preserves a shape's explicit empty fill — the transform emits '' for gradient / image-filled / unfilled shapes", () => {
    const el = {
      ...box,
      type: 'shape',
      viewBox: [200, 200],
      path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z',
      fill: '',
      gradient: { type: 'linear', colors: [], rotate: 90 },
      fixedRatio: false,
    };
    const [slide] = normalizeImportedSlides([baseSlide([el])]);
    expect(slide.elements[0]).toMatchObject({ type: 'shape', fill: '' });
  });

  it('drops an element normalization cannot repair, keeps the rest, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [slide] = normalizeImportedSlides([
      baseSlide([
        { ...box, type: 'text', content: '<p>ok</p>' },
        { ...box, id: 'e2', type: 'text', defaultColor: 123 },
      ]),
    ]);
    expect(slide.elements).toHaveLength(1);
    expect(slide.elements[0].id).toBe('e1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping element'));
    warn.mockRestore();
  });

  it('does not mutate its input', () => {
    const el = { ...box, type: 'text', content: '<p>hi</p>' };
    const input = [baseSlide([el])];
    normalizeImportedSlides(input);
    expect(input[0].elements[0]).toBe(el);
    expect('defaultFontName' in (el as Record<string, unknown>)).toBe(false);
  });
});

describe('parsedToSlides · normalize boundary', () => {
  it("keeps an unfilled shape transparent end to end — the boundary must not default the transform's fill: ''", async () => {
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
              type: 'shape',
              shapType: 'rect',
              left: 100,
              top: 100,
              width: 200,
              height: 120,
              name: 'unfilled box',
              order: 1,
              rotate: 0,
              content: '<div></div>',
              // no `fill` → the transform emits the DSL shape with fill: ''
              // (meaning transparent / no solid fill; the renderer maps '' to
              // `none`). Regression test: the normalize boundary must pass that
              // through instead of painting it with the contract default.
              borderWidth: 0,
              borderColor: '#000000',
              borderType: 'solid',
              borderStrokeDasharray: '0',
              vAlign: 'mid',
              isFlipH: false,
              isFlipV: false,
            },
          ],
        },
      ],
    };

    const slides = await parsedToSlides(json as unknown as Parameters<typeof parsedToSlides>[0]);
    expect(slides).toHaveLength(1);
    const [shape] = slides[0].elements;
    expect(shape.type).toBe('shape');
    expect((shape as { fill?: string }).fill).toBe('');
  });
});
