import { describe, expect, it } from 'vitest';
import { transformParsedToSlides } from '../src/import-pipeline/transformParsedToSlides';
import { createMockImportContext } from '../src/import-pipeline/mockContext';
import type { ImportWarning } from '../src/import-pipeline/types';

const LEGACY_RED_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const REAL_IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

interface FixtureElement {
  type: string;
  [key: string]: unknown;
}

function buildJson(
  elements: FixtureElement[],
  fill: Record<string, unknown> = { type: 'color', value: '#ffffff' },
) {
  return {
    size: { width: 960, height: 540 },
    themeColors: [],
    slides: [
      {
        fill,
        note: '',
        layoutElements: [],
        elements,
      },
    ],
  };
}

function baseImageElement(overrides: Record<string, unknown> = {}): FixtureElement {
  return {
    type: 'image',
    left: 10,
    top: 20,
    width: 100,
    height: 50,
    name: '公式',
    order: 1,
    src: LEGACY_RED_PLACEHOLDER,
    rotate: 0,
    isFlipH: false,
    isFlipV: false,
    ...overrides,
  };
}

function mathElement(overrides: Record<string, unknown> = {}): FixtureElement {
  return {
    type: 'math',
    left: 30,
    top: 40,
    width: 200,
    height: 40,
    order: 1,
    latex: '',
    picBase64: LEGACY_RED_PLACEHOLDER,
    ...overrides,
  };
}

async function run(json: unknown) {
  const warnings: ImportWarning[] = [];
  const { slides } = await transformParsedToSlides(
    json as unknown as Parameters<typeof transformParsedToSlides>[0],
    createMockImportContext({
      viewportWidth: 1280,
      onWarning: (w) => warnings.push(w),
    }),
  );
  return { slides, warnings };
}

describe('transformParsedToSlides · degrade warnings', () => {
  it('warns media-unconvertible for an image element whose src is the placeholder', async () => {
    const { slides, warnings } = await run(buildJson([baseImageElement()]));
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'media-unconvertible', slideIndex: 0 }),
    ]);
    // Upstream does not strip the element — consumers decide via the warning.
    expect(slides[0].elements.filter((e) => e.type === 'image')).toHaveLength(1);
  });

  it('does not warn for a real image src', async () => {
    const { warnings } = await run(buildJson([baseImageElement({ src: REAL_IMAGE_DATA_URL })]));
    expect(warnings).toEqual([]);
  });

  it('keeps formula plain text when the fallback picture is unconvertible', async () => {
    const { slides, warnings } = await run(buildJson([mathElement({ text: 'A=a·b' })]));
    const types = slides[0].elements.map((e) => e.type);
    expect(types).toContain('text');
    expect(types).not.toContain('image');
    const text = slides[0].elements.find((e) => e.type === 'text') as { content: string };
    expect(text.content).toContain('A=a·b');
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'formula-fallback-image', slideIndex: 0 }),
    ]);
  });

  it('falls back to the image element (with warning) when no plain text survives', async () => {
    const { slides, warnings } = await run(buildJson([mathElement({ text: undefined })]));
    expect(slides[0].elements.map((e) => e.type)).toEqual(['image']);
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'formula-fallback-image', slideIndex: 0 }),
    ]);
  });

  it('prefers the real fallback picture over plain text when it carries pixels', async () => {
    const { slides, warnings } = await run(
      buildJson([mathElement({ text: 'A=a·b', picBase64: REAL_IMAGE_DATA_URL })]),
    );
    expect(slides[0].elements.map((e) => e.type)).toEqual(['image']);
    expect(warnings).toEqual([expect.objectContaining({ code: 'formula-fallback-image' })]);
  });

  it('warns media-unconvertible for a placeholder background image', async () => {
    const { warnings } = await run(
      buildJson([], { type: 'image', value: { picBase64: LEGACY_RED_PLACEHOLDER } }),
    );
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'media-unconvertible', slideIndex: 0 }),
    ]);
  });

  it('warns media-unconvertible for a shape image-fill pattern placeholder', async () => {
    const { warnings } = await run(
      buildJson([
        {
          type: 'shape',
          left: 10,
          top: 10,
          width: 100,
          height: 100,
          order: 1,
          rotate: 0,
          content: '<div><p>x</p></div>',
          fill: { type: 'image', value: { picBase64: LEGACY_RED_PLACEHOLDER, opacity: 1 } },
          borderWidth: 0,
          borderColor: '#000',
          borderType: 'solid',
          borderStrokeDasharray: '0',
          vAlign: 'mid',
        },
      ]),
    );
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'media-unconvertible', slideIndex: 0 }),
    ]);
  });

  it('stays silent when no onWarning sink is wired', async () => {
    const { slides } = await transformParsedToSlides(
      buildJson([baseImageElement()]) as unknown as Parameters<typeof transformParsedToSlides>[0],
      createMockImportContext({ viewportWidth: 1280 }),
    );
    expect(slides[0].elements.filter((e) => e.type === 'image')).toHaveLength(1);
  });
});

describe('transformParsedToSlides · degraded formulas & sink isolation', () => {
  it('emits formula-degraded when an MTEF conversion was approximated', async () => {
    const json = buildJson([
      mathElement({
        latex: 'x',
        text: undefined,
        degraded: true,
      } as never),
    ]);
    const { slides, warnings } = await run(json);
    // KaTeX succeeds on 'x' → latex element + approximation warning.
    expect(slides[0].elements.map((e) => e.type)).toEqual(['latex']);
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'formula-degraded', slideIndex: 0 }),
    ]);
  });

  it('a throwing onWarning sink never fails the import', async () => {
    const warnings: ImportWarning[] = [];
    const { slides } = await transformParsedToSlides(
      buildJson([baseImageElement()]) as unknown as Parameters<typeof transformParsedToSlides>[0],
      createMockImportContext({
        viewportWidth: 1280,
        onWarning: (w) => {
          warnings.push(w);
          throw new Error('sink exploded');
        },
      }),
    );
    expect(slides[0].elements.filter((e) => e.type === 'image')).toHaveLength(1);
    expect(warnings).toHaveLength(1); // the call happened, the throw was swallowed
  });
});
