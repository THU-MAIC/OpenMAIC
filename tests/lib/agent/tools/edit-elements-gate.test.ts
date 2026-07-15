import { describe, expect, it } from 'vitest';
import * as editElementsGate from '@/lib/agent/tools/edit-elements-gate';
import {
  ALLOWED_EDIT_PROPS,
  buildElementInventory,
  clampUpdateProps,
  elementInventoryFingerprint,
  getEditablePropSchema,
  mapProposalsToEditIntents,
  normalizeRotate,
  type ElementInventoryItem,
} from '@/lib/agent/tools/edit-elements-gate';
import type { PPTElement } from '@openmaic/dsl';

type SubsetValidator = (
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
) => string | null;

function textEl(overrides: Partial<PPTElement> & { id: string }): ElementInventoryItem {
  return {
    id: overrides.id,
    type: 'text',
    left: 100,
    top: 80,
    width: 400,
    height: 60,
    rotate: 0,
    lock: false,
    label: 'Title',
    style: { defaultColor: '#333333' },
    ...('lock' in overrides ? { lock: !!overrides.lock } : {}),
  };
}

const inventory: ElementInventoryItem[] = [
  textEl({ id: 'title-1' }),
  {
    id: 'fig-1',
    type: 'shape',
    left: 200,
    top: 200,
    width: 120,
    height: 120,
    rotate: 0,
    lock: false,
    label: 'figure',
    style: { fill: '#eeeeee' },
  },
  {
    id: 'locked-1',
    type: 'text',
    left: 10,
    top: 10,
    width: 100,
    height: 40,
    rotate: 0,
    lock: true,
    label: 'locked',
    style: {},
  },
];

describe('edit-elements-gate', () => {
  it('refuses an empty update batch', () => {
    expect(mapProposalsToEditIntents([], inventory)).toEqual({
      ok: false,
      reason: 'no element updates proposed',
    });
  });

  it('maps a single color+position update to element.update', () => {
    const result = mapProposalsToEditIntents(
      [{ id: 'title-1', props: { defaultColor: '#0000ff', top: 40 } }],
      inventory,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intents).toEqual([
      {
        type: 'element.update',
        id: 'title-1',
        props: { defaultColor: '#0000ff', top: 40 },
      },
    ]);
  });

  it('refuses edits to the renderer-managed text sizing axis', () => {
    const horizontal = textEl({ id: 'horizontal' });
    const vertical = { ...textEl({ id: 'vertical' }), style: { vertical: true } };

    const horizontalHeight = mapProposalsToEditIntents(
      [{ id: 'horizontal', props: { height: 120 } }],
      [horizontal],
    );
    const verticalWidth = mapProposalsToEditIntents(
      [{ id: 'vertical', props: { width: 120 } }],
      [vertical],
    );

    expect(horizontalHeight.ok).toBe(false);
    expect(verticalWidth.ok).toBe(false);
    if (!horizontalHeight.ok) expect(horizontalHeight.reason).toMatch(/automatic height/i);
    if (!verticalWidth.ok) expect(verticalWidth.reason).toMatch(/automatic width/i);
    expect(
      mapProposalsToEditIntents([{ id: 'horizontal', props: { width: 500 } }], [horizontal]).ok,
    ).toBe(true);
    expect(
      mapProposalsToEditIntents([{ id: 'vertical', props: { height: 500 } }], [vertical]).ok,
    ).toBe(true);
  });

  it('refuses defaultColor when inline text color would override it', () => {
    const [inlineColored] = buildElementInventory([
      {
        id: 'imported-title',
        type: 'text',
        left: 100,
        top: 80,
        width: 400,
        height: 60,
        rotate: 0,
        content: '<p><span style="font-size: 28px; color: #123456">Title</span></p>',
        defaultColor: '#333333',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);

    const result = mapProposalsToEditIntents(
      [{ id: 'imported-title', props: { defaultColor: '#0000ff' } }],
      [inlineColored],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/inline text color/i);
  });

  it('refuses defaultFontName when inline font-family would override it', () => {
    const [inlineFont] = buildElementInventory([
      {
        id: 'imported-title',
        type: 'text',
        left: 100,
        top: 80,
        width: 400,
        height: 60,
        rotate: 0,
        content: '<p><span style="font-family: Aptos; font-size: 28px">Title</span></p>',
        defaultColor: '#333333',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);

    const result = mapProposalsToEditIntents(
      [{ id: 'imported-title', props: { defaultFontName: 'Inter' } }],
      [inlineFont],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/inline font-family/i);
  });

  it('refuses text spacing props hidden by descendant inline styles', () => {
    const [inlineSpacing] = buildElementInventory([
      {
        id: 'imported-title',
        type: 'text',
        left: 100,
        top: 80,
        width: 400,
        height: 60,
        rotate: 0,
        content:
          '<p style="line-height: 1.8; margin-bottom: 12px"><span style="letter-spacing: 2px">Title</span></p>',
        defaultColor: '#333333',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);

    for (const props of [{ lineHeight: 1.5 }, { wordSpace: 4 }, { paragraphSpace: 8 }]) {
      const result = mapProposalsToEditIntents([{ id: 'imported-title', props }], [inlineSpacing]);
      expect(result.ok, JSON.stringify(props)).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/inline/i);
    }
  });

  it('detects inline spacing overrides inside shape labels', () => {
    const [shapeLabel] = buildElementInventory([
      {
        id: 'shape-label',
        type: 'shape',
        left: 0,
        top: 0,
        width: 100,
        height: 80,
        rotate: 0,
        viewBox: [100, 80],
        path: 'M0 0',
        fixedRatio: false,
        fill: '#fff',
        text: {
          content: '<p style="line-height: 2; margin-bottom: 6px">Label</p>',
          defaultFontName: 'Arial',
          defaultColor: '#111',
          align: 'middle',
        },
      } as PPTElement,
    ]);

    expect(
      mapProposalsToEditIntents([{ id: 'shape-label', props: { lineHeight: 1.5 } }], [shapeLabel])
        .ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents(
        [{ id: 'shape-label', props: { paragraphSpace: 10 } }],
        [shapeLabel],
      ).ok,
    ).toBe(false);
  });

  it('does not mistake background-color for inline text color', () => {
    const [backgroundOnly] = buildElementInventory([
      {
        id: 'title',
        type: 'text',
        left: 100,
        top: 80,
        width: 400,
        height: 60,
        rotate: 0,
        content: '<p><span style="background-color: #fff">Title</span></p>',
        defaultColor: '#333333',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);

    expect(
      mapProposalsToEditIntents(
        [{ id: 'title', props: { defaultColor: '#0000ff' } }],
        [backgroundOnly],
      ).ok,
    ).toBe(true);
  });

  it('maps mixed-target updates to one element.updateMany', () => {
    const result = mapProposalsToEditIntents(
      [
        { id: 'title-1', props: { defaultColor: '#0000ff' } },
        { id: 'fig-1', props: { left: 200, top: 260 } },
      ],
      inventory,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].type).toBe('element.updateMany');
  });

  it('refuses unknown element ids (nothing partial)', () => {
    const result = mapProposalsToEditIntents([{ id: 'nope', props: { top: 10 } }], inventory);
    expect(result).toEqual({
      ok: false,
      reason: 'unknown element id "nope"',
    });
  });

  it('refuses locked elements', () => {
    const result = mapProposalsToEditIntents([{ id: 'locked-1', props: { top: 20 } }], inventory);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/locked/);
  });

  it('refuses content props like content/src', () => {
    const result = mapProposalsToEditIntents(
      [{ id: 'title-1', props: { content: '<p>hi</p>' } }],
      inventory,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not editable/);
  });

  it('refuses out-of-contract props', () => {
    const result = mapProposalsToEditIntents([{ id: 'title-1', props: { mystery: 1 } }], inventory);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/out of contract/);
  });

  it('refuses empty props', () => {
    const result = mapProposalsToEditIntents([{ id: 'title-1', props: {} }], inventory);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/empty props/i);
  });

  it('refuses the whole batch when one update is bad', () => {
    const result = mapProposalsToEditIntents(
      [
        { id: 'title-1', props: { top: 10 } },
        { id: 'nope', props: { top: 10 } },
      ],
      inventory,
    );
    expect(result.ok).toBe(false);
  });

  it('clamps width to MIN_SIZE for text (40)', () => {
    expect(clampUpdateProps('text', { width: 5 })).toEqual({
      width: 40,
    });
  });

  it('normalizes rotate into (-180, 180]', () => {
    expect(normalizeRotate(270)).toBe(-90);
    expect(normalizeRotate(-270)).toBe(90);
    expect(normalizeRotate(180)).toBe(180);
  });

  it('refuses coordinates outside the canvas sanity bounds', () => {
    const result = mapProposalsToEditIntents([{ id: 'title-1', props: { left: 1e15 } }], inventory);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/left out of bounds/i);
  });

  it('refuses non-finite rotate values', () => {
    for (const rotate of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = mapProposalsToEditIntents([{ id: 'title-1', props: { rotate } }], inventory);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/rotate must be a finite number/i);
    }
  });

  it('builds inventory labels from text content', () => {
    const els = [
      {
        id: 't1',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content: '<p>Hello <b>World</b></p>',
        defaultFontName: 'Arial',
        defaultColor: '#111',
      },
    ] as unknown as PPTElement[];
    const inv = buildElementInventory(els);
    expect(inv[0].label).toBe('Hello World');
    expect(inv[0].style.defaultColor).toBe('#111');
  });

  it('maps shape text vertical alignment into inventory and fingerprints', () => {
    const shape = {
      id: 'shape-label',
      type: 'shape',
      left: 0,
      top: 0,
      width: 100,
      height: 80,
      rotate: 0,
      viewBox: [100, 80],
      path: 'M0 0',
      fixedRatio: false,
      fill: '#fff',
      text: {
        content: 'Label',
        defaultFontName: 'Arial',
        defaultColor: '#111',
        align: 'bottom',
      },
    } as PPTElement;

    expect(buildElementInventory([shape])[0].style.vAlign).toBe('bottom');
  });

  it('fingerprints shape patterns that fill and gradient edits would replace', () => {
    const shape = {
      id: 'pattern-shape',
      type: 'shape',
      left: 0,
      top: 0,
      width: 100,
      height: 80,
      rotate: 0,
      viewBox: [100, 80],
      path: 'M0 0',
      fixedRatio: false,
      fill: '#ffffff',
      pattern: 'https://example.com/a.png',
    } as PPTElement;
    const changed = { ...shape, pattern: 'https://example.com/b.png' } as PPTElement;

    expect(elementInventoryFingerprint(shape)).not.toBe(elementInventoryFingerprint(changed));
    const collisionA = {
      ...shape,
      pattern: 'https://e.test/1fiw1ko1qmpx6m',
    } as PPTElement;
    const collisionB = {
      ...shape,
      pattern: 'https://e.test/17zdu9zpfflr',
    } as PPTElement;
    expect(elementInventoryFingerprint(collisionA)).not.toBe(
      elementInventoryFingerprint(collisionB),
    );
    const [item] = buildElementInventory([shape]);
    expect(
      mapProposalsToEditIntents([{ id: shape.id, props: { fill: '#ffffff' } }], [item]).ok,
    ).toBe(true);
  });

  it('fingerprints hidden state consumed by resize application', () => {
    const tableData = [[{ id: 'cell-1', text: 'x' }]];
    const table = {
      id: 'resize-table',
      type: 'table',
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      rotate: 0,
      data: tableData,
      colWidths: [1],
      rowHeights: [20],
      cellMinHeight: 36,
    } as unknown as PPTElement;
    expect(elementInventoryFingerprint(table)).not.toBe(
      elementInventoryFingerprint({ ...table, rowHeights: [80] } as PPTElement),
    );
    expect(elementInventoryFingerprint(table)).not.toBe(
      elementInventoryFingerprint({ ...table, cellMinHeight: 72 } as PPTElement),
    );
    expect(elementInventoryFingerprint(table)).not.toBe(
      elementInventoryFingerprint({ ...table, data: [...tableData, []] } as PPTElement),
    );

    const shape = {
      id: 'resize-shape',
      type: 'shape',
      left: 0,
      top: 0,
      width: 100,
      height: 80,
      rotate: 0,
      viewBox: [100, 80],
      path: 'M0 0',
      pathFormula: 'rect',
      keypoints: [1],
      fixedRatio: false,
    } as unknown as PPTElement;
    expect(elementInventoryFingerprint(shape)).not.toBe(
      elementInventoryFingerprint({
        ...shape,
        pathFormula: 'triangle',
        keypoints: [99],
      } as PPTElement),
    );
  });

  it('fingerprints exact HTML dependencies used by composed visibility', () => {
    const text = {
      id: 'visibility-fingerprint',
      type: 'text',
      left: 0,
      top: 0,
      width: 100,
      height: 40,
      rotate: 0,
      defaultColor: 'transparent',
      defaultFontName: 'Arial',
      content:
        '<span style="-webkit-text-fill-color:transparent;text-shadow:0 0 2px currentColor">x</span>',
    } as PPTElement;
    const changed = {
      ...text,
      content:
        '<span style="-webkit-text-fill-color:transparent;text-shadow:0 0 2px transparent">x</span>',
    } as PPTElement;
    expect(JSON.stringify(buildElementInventory([text])[0])).toBe(
      JSON.stringify(buildElementInventory([changed])[0]),
    );
    expect(elementInventoryFingerprint(text)).not.toBe(elementInventoryFingerprint(changed));
  });

  it('refuses malformed prop values (outline/shadow/color)', () => {
    expect(
      mapProposalsToEditIntents([{ id: 'title-1', props: { outline: 17 } }], inventory).ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents([{ id: 'title-1', props: { shadow: 'big' } }], inventory).ok,
    ).toBe(false);
    for (const invalidColor of [
      'ff0000',
      'rgb(1,2,3) trailing',
      'rgb(1,2,3 junk)',
      'rgb(1,,2,3)',
      'rgb(10%, 20, 30%)',
      'rgba(10%, 20, 30%, .5)',
      'rgba(1, 2, 3, 50%)',
      'hsla(10, 20%, 30%, 50%)',
      'hsl(10,20,30)',
    ]) {
      expect(
        mapProposalsToEditIntents(
          [{ id: 'title-1', props: { defaultColor: invalidColor } }],
          inventory,
        ).ok,
      ).toBe(false);
    }
    expect(
      mapProposalsToEditIntents([{ id: 'title-1', props: { defaultColor: 12 } }], inventory).ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents(
        [{ id: 'title-1', props: { rotate: '45' as unknown as number } }],
        inventory,
      ).ok,
    ).toBe(false);
  });

  it('validates lineHeight as a multiplier independently from pixel spacing', () => {
    for (const lineHeight of [1, 1.5, 3]) {
      expect(
        mapProposalsToEditIntents([{ id: 'title-1', props: { lineHeight } }], inventory).ok,
      ).toBe(true);
    }

    for (const lineHeight of [0.9, 3.1, 20]) {
      const result = mapProposalsToEditIntents(
        [{ id: 'title-1', props: { lineHeight } }],
        inventory,
      );
      expect(result.ok, String(lineHeight)).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/lineHeight.*1\.\.3/i);
    }

    expect(
      mapProposalsToEditIntents(
        [{ id: 'title-1', props: { wordSpace: 20, paragraphSpace: 20 } }],
        inventory,
      ).ok,
    ).toBe(true);
  });

  it('refuses negative shadow blur that would produce invalid CSS', () => {
    const result = mapProposalsToEditIntents(
      [
        {
          id: 'title-1',
          props: { shadow: { h: 2, v: 2, blur: -10, color: '#000000' } },
        },
      ],
      inventory,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/shadow\.blur/i);
  });

  it('refuses junk nested inside gradient', () => {
    const result = mapProposalsToEditIntents(
      [
        {
          id: 'fig-1',
          props: {
            gradient: { type: 'linear', colors: ['#f00', '#00f'], rotate: 0 },
          },
        },
      ],
      inventory,
    );
    expect(result.ok).toBe(false);
  });

  it('accepts a well-formed gradient on shapes', () => {
    const result = mapProposalsToEditIntents(
      [
        {
          id: 'fig-1',
          props: {
            gradient: {
              type: 'linear',
              colors: [
                { pos: 0, color: '#f00' },
                { pos: 100, color: '#00f' },
              ],
              rotate: 0,
            },
          },
        },
      ],
      inventory,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses color on text and shape elements because the DSL has no top-level color there', () => {
    const textResult = mapProposalsToEditIntents(
      [{ id: 'title-1', props: { color: '#f00' } }],
      inventory,
    );
    expect(textResult.ok).toBe(false);
    if (textResult.ok) return;
    expect(textResult.reason).toMatch(/color is not valid on text elements/i);

    const shapeResult = mapProposalsToEditIntents(
      [{ id: 'fig-1', props: { color: '#f00' } }],
      inventory,
    );
    expect(shapeResult.ok).toBe(false);
    if (shapeResult.ok) return;
    expect(shapeResult.reason).toMatch(/color is not valid on shape elements/i);
  });

  it('allows fill on chart elements because the DSL chart schema owns it', () => {
    const chartInventory: ElementInventoryItem[] = [
      {
        id: 'chart-1',
        type: 'chart',
        left: 0,
        top: 0,
        width: 320,
        height: 180,
        rotate: 0,
        lock: false,
        label: 'chart',
        style: { themeColors: ['#f00'] },
      },
    ];
    const result = mapProposalsToEditIntents(
      [{ id: 'chart-1', props: { fill: '#ffffff' } }],
      chartInventory,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses vertical on shapes because ShapeText has no vertical prop', () => {
    const result = mapProposalsToEditIntents(
      [{ id: 'fig-1', props: { vertical: true } }],
      inventory,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/vertical is not valid on shape elements/i);
  });

  it('refuses textType because it is semantic metadata, not a visible Pro edit', () => {
    const result = mapProposalsToEditIntents(
      [{ id: 'title-1', props: { textType: 'title' } }],
      inventory,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/textType/i);
  });

  it('derives editable prop schemas from the DSL schema', () => {
    for (const key of ALLOWED_EDIT_PROPS) {
      const owningTypes = [
        'text',
        'image',
        'shape',
        'line',
        'chart',
        'table',
        'latex',
        'video',
        'audio',
        'code',
      ].filter((type) => getEditablePropSchema(type, key));
      expect(owningTypes, `${key} should resolve for at least one element type`).not.toHaveLength(
        0,
      );
    }

    expect(getEditablePropSchema('text', 'notARealProp')).toBeNull();
    expect(getEditablePropSchema('shape', 'notARealProp')).toBeNull();
  });

  it('keeps layered policy on top of schema-derived object validation', () => {
    const tooManyStops = Array.from({ length: 11 }, (_, i) => ({
      pos: i * 10,
      color: '#f00',
    }));
    const gradientResult = mapProposalsToEditIntents(
      [
        {
          id: 'fig-1',
          props: {
            gradient: { type: 'linear', colors: tooManyStops, rotate: 0 },
          },
        },
      ],
      inventory,
    );
    expect(gradientResult.ok).toBe(false);
    if (gradientResult.ok) return;
    expect(gradientResult.reason).toMatch(/gradient.colors/i);

    const imageInventory: ElementInventoryItem[] = [
      {
        id: 'img-1',
        type: 'image',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        rotate: 0,
        lock: false,
        label: 'pic',
        style: {},
      },
    ];
    const filterResult = mapProposalsToEditIntents(
      [{ id: 'img-1', props: { filters: { blur: 'x'.repeat(41) } } }],
      imageInventory,
    );
    expect(filterResult.ok).toBe(false);
    if (filterResult.ok) return;
    expect(filterResult.reason).toMatch(/filters.blur/i);
  });

  it('normalizes image filter values to canonical unitless strings', () => {
    const imageInventory: ElementInventoryItem[] = [
      {
        id: 'img-1',
        type: 'image',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        rotate: 0,
        lock: false,
        label: 'pic',
        style: {},
      },
    ];

    const result = mapProposalsToEditIntents(
      [{ id: 'img-1', props: { filters: { brightness: '120%', blur: '2px' } } }],
      imageInventory,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intents).toEqual([
      {
        type: 'element.update',
        id: 'img-1',
        props: { filters: { brightness: '120', blur: '2' } },
      },
    ]);
  });

  it('refuses image filter values outside renderable CSS ranges', () => {
    const imageInventory: ElementInventoryItem[] = [
      {
        id: 'img-1',
        type: 'image',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        rotate: 0,
        lock: false,
        label: 'pic',
        style: {},
      },
    ];

    for (const filters of [
      { blur: '-2' },
      { brightness: '-20%' },
      { opacity: '101%' },
      { invert: '120' },
    ]) {
      const result = mapProposalsToEditIntents(
        [{ id: 'img-1', props: { filters } }],
        imageInventory,
      );
      expect(result.ok, JSON.stringify(filters)).toBe(false);
    }
  });

  it('keeps themeColors non-empty', () => {
    const chartInventory: ElementInventoryItem[] = [
      {
        id: 'chart-1',
        type: 'chart',
        left: 0,
        top: 0,
        width: 320,
        height: 180,
        rotate: 0,
        lock: false,
        label: 'chart',
        style: { themeColors: ['#f00'] },
      },
    ];
    const result = mapProposalsToEditIntents(
      [{ id: 'chart-1', props: { themeColors: [] } }],
      chartInventory,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/themeColors/i);
  });

  it('refuses defaultColor on image elements', () => {
    const inv: ElementInventoryItem[] = [
      {
        id: 'img-1',
        type: 'image',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        rotate: 0,
        lock: false,
        label: 'pic',
        style: {},
      },
    ];
    expect(
      mapProposalsToEditIntents([{ id: 'img-1', props: { defaultColor: '#f00' } }], inv).ok,
    ).toBe(false);
  });

  it('clamps line stroke width with min 1, not box MIN_SIZE', () => {
    expect(clampUpdateProps('line', { width: 0.5 })).toEqual({ width: 1 });
    expect(clampUpdateProps('line', { width: 4 })).toEqual({ width: 4 });
  });

  it('clamps opacity overshoot on valid opacity props', () => {
    const faded = [{ ...inventory[0], style: { ...inventory[0].style, opacity: 0.5 } }];
    const result = mapProposalsToEditIntents([{ id: 'title-1', props: { opacity: 1.5 } }], faded);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.intents).toEqual([
      {
        type: 'element.update',
        id: 'title-1',
        props: { opacity: 1 },
      },
    ]);
    expect(clampUpdateProps('text', { opacity: -0.25 })).toEqual({
      opacity: 0,
    });
  });

  it('fails closed for schema refs and constructs the subset checker cannot validate', () => {
    const validateJsonSchemaSubset = (
      editElementsGate as typeof editElementsGate & {
        validateJsonSchemaSubset?: SubsetValidator;
      }
    ).validateJsonSchemaSubset;

    expect(
      validateJsonSchemaSubset?.(
        'anything',
        { $ref: '#/definitions/DefinitelyMissing' },
        'prop fill',
      ),
    ).toBe('prop fill uses a schema construct the gate cannot validate');
    expect(
      validateJsonSchemaSubset?.('anything', { oneOf: [{ type: 'string' }] }, 'prop fill'),
    ).toBe('prop fill uses a schema construct the gate cannot validate');
    expect(validateJsonSchemaSubset?.('anything', {}, 'prop fill')).toBeNull();
  });

  it('refuses partial group updates', () => {
    const grouped: ElementInventoryItem[] = [
      { ...textEl({ id: 'g1' }), groupId: 'grp' },
      {
        id: 'g2',
        type: 'shape',
        left: 0,
        top: 0,
        width: 50,
        height: 50,
        rotate: 0,
        lock: false,
        label: 'icon',
        style: { fill: '#5b9bd5' },
        groupId: 'grp',
      },
    ];
    const result = mapProposalsToEditIntents([{ id: 'g1', props: { left: 10 } }], grouped);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/group/i);
  });

  it('allows updating every member of a group together', () => {
    const grouped: ElementInventoryItem[] = [
      { ...textEl({ id: 'g1' }), groupId: 'grp' },
      {
        id: 'g2',
        type: 'shape',
        left: 0,
        top: 0,
        width: 50,
        height: 50,
        rotate: 0,
        lock: false,
        label: 'icon',
        style: { fill: '#5b9bd5' },
        groupId: 'grp',
      },
    ];
    const result = mapProposalsToEditIntents(
      [
        { id: 'g1', props: { left: 110, top: 100 } },
        { id: 'g2', props: { left: 10, top: 20 } },
      ],
      grouped,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses non-rigid group movement and grouped resize', () => {
    const grouped: ElementInventoryItem[] = [
      { ...textEl({ id: 'g1' }), groupId: 'grp' },
      {
        id: 'g2',
        type: 'shape',
        left: 0,
        top: 0,
        width: 50,
        height: 50,
        rotate: 0,
        lock: false,
        label: 'icon',
        style: { fill: '#5b9bd5' },
        groupId: 'grp',
      },
    ];

    const nonRigid = mapProposalsToEditIntents(
      [
        { id: 'g1', props: { left: 110 } },
        { id: 'g2', props: { left: 20 } },
      ],
      grouped,
    );
    const resize = mapProposalsToEditIntents(
      [
        { id: 'g1', props: { width: 500 } },
        { id: 'g2', props: { width: 60 } },
      ],
      grouped,
    );

    expect(nonRigid.ok).toBe(false);
    if (!nonRigid.ok) expect(nonRigid.reason).toMatch(/rigid translation/i);
    expect(resize.ok).toBe(false);
    if (!resize.ok) expect(resize.reason).toMatch(/resize or rotate/i);
  });

  it('allows rigid group translation with decimal canvas coordinates', () => {
    const grouped: ElementInventoryItem[] = [
      { ...textEl({ id: 'g1' }), left: 0.1, groupId: 'grp' },
      {
        id: 'g2',
        type: 'shape',
        left: 100.2,
        top: 0,
        width: 50,
        height: 50,
        rotate: 0,
        lock: false,
        label: 'icon',
        style: { fill: '#5b9bd5' },
        groupId: 'grp',
      },
    ];

    const result = mapProposalsToEditIntents(
      [
        { id: 'g1', props: { left: 10.2 } },
        { id: 'g2', props: { left: 110.3 } },
      ],
      grouped,
    );

    expect(result.ok).toBe(true);
  });

  it('surfaces groupId on inventory items', () => {
    const els = [
      {
        id: 't1',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        groupId: 'g',
        content: 'x',
        defaultFontName: 'Arial',
        defaultColor: '#111',
      },
    ] as unknown as PPTElement[];
    expect(buildElementInventory(els)[0].groupId).toBe('g');
  });

  it('refuses props the active Pro editor cannot render', () => {
    const unsupported: ElementInventoryItem[] = [
      {
        id: 'code-1',
        type: 'code',
        left: 0,
        top: 0,
        width: 200,
        height: 100,
        rotate: 0,
        lock: false,
        label: 'code',
        style: { fontSize: 16 },
      },
      {
        id: 'audio-1',
        type: 'audio',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        lock: false,
        label: 'audio',
        style: { color: '#000000' },
      },
    ];

    expect(
      mapProposalsToEditIntents([{ id: 'code-1', props: { fontSize: 20 } }], unsupported).ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents([{ id: 'audio-1', props: { color: '#ff0000' } }], unsupported).ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents([{ id: 'title-1', props: { vAlign: 'bottom' } }], inventory).ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents([{ id: 'title-1', props: { textType: 'title' } }], inventory).ok,
    ).toBe(false);
  });

  it('refuses visually equivalent color and filter updates as no-ops', () => {
    const colorEquivalent = mapProposalsToEditIntents(
      [{ id: 'title-1', props: { defaultColor: 'rgb(51, 51, 51)' } }],
      inventory,
    );
    expect(colorEquivalent.ok).toBe(false);
    if (!colorEquivalent.ok) expect(colorEquivalent.reason).toMatch(/no effective change/i);

    const nestedColorInventory: ElementInventoryItem[] = [
      {
        ...inventory[1],
        style: { outline: { width: 2, color: '#ff0000' } },
      },
    ];
    const nestedColorEquivalent = mapProposalsToEditIntents(
      [{ id: 'fig-1', props: { outline: { color: 'red' } } }],
      nestedColorInventory,
    );
    expect(nestedColorEquivalent.ok).toBe(false);
    if (!nestedColorEquivalent.ok)
      expect(nestedColorEquivalent.reason).toMatch(/no effective change/i);

    const filterInventory: ElementInventoryItem[] = [
      {
        id: 'image-1',
        type: 'image',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        rotate: 0,
        lock: false,
        label: 'image',
        imageClipShape: 'rect',
        style: { filters: { blur: '2px' } },
      },
    ];
    const filterEquivalent = mapProposalsToEditIntents(
      [{ id: 'image-1', props: { filters: { blur: '2' } } }],
      filterInventory,
    );
    expect(filterEquivalent.ok).toBe(false);
    if (!filterEquivalent.ok) expect(filterEquivalent.reason).toMatch(/no effective change/i);

    const transparentInventory = [
      { ...inventory[0], id: 'transparent', style: { defaultColor: 'transparent' } },
    ];
    const transparentEquivalent = mapProposalsToEditIntents(
      [{ id: 'transparent', props: { defaultColor: 'rgba(255, 0, 0, 0)' } }],
      transparentInventory,
    );
    expect(transparentEquivalent.ok).toBe(false);
    if (!transparentEquivalent.ok)
      expect(transparentEquivalent.reason).toMatch(/no effective change/i);
  });

  it('matches shared outline renderer defaults and dotted semantics', () => {
    const outlined: ElementInventoryItem[] = [
      {
        ...inventory[1],
        style: { outline: { width: 2 } },
      },
    ];
    expect(
      mapProposalsToEditIntents(
        [{ id: 'fig-1', props: { outline: { color: '#000000' } } }],
        outlined,
      ).ok,
    ).toBe(true);
    expect(
      mapProposalsToEditIntents(
        [{ id: 'fig-1', props: { outline: { color: '#d14424' } } }],
        outlined,
      ).ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents(
        [{ id: 'fig-1', props: { outline: { style: 'dotted' } } }],
        outlined,
      ).ok,
    ).toBe(true);
  });

  it('normalizes gradient rotation according to renderer semantics', () => {
    const colors = [
      { pos: 0, color: '#ff0000' },
      { pos: 100, color: '#0000ff' },
    ];
    for (const [type, currentRotate, nextRotate] of [
      ['radial', 0, 90],
      ['linear', 0, 360],
    ] as const) {
      const item: ElementInventoryItem = {
        ...inventory[1],
        id: `${type}-gradient`,
        style: { gradient: { type, rotate: currentRotate, colors } },
      };
      const result = mapProposalsToEditIntents(
        [{ id: item.id, props: { gradient: { type, rotate: nextRotate, colors } } }],
        [item],
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/no effective change/i);
    }
  });

  it('normalizes monochrome gradients as solid paint', () => {
    const item: ElementInventoryItem = {
      ...inventory[1],
      id: 'solid-gradient',
      style: {
        gradient: {
          type: 'linear',
          rotate: 0,
          colors: [
            { pos: 0, color: '#ff0000' },
            { pos: 100, color: 'red' },
          ],
        },
      },
    };
    const result = mapProposalsToEditIntents(
      [
        {
          id: item.id,
          props: {
            gradient: {
              type: 'linear',
              rotate: 45,
              colors: [
                { pos: 25, color: '#ff0000' },
                { pos: 75, color: '#ff0000' },
              ],
            },
          },
        },
      ],
      [item],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no effective change/i);

    const solid: ElementInventoryItem = {
      ...inventory[1],
      id: 'solid-fill',
      style: { fill: '#ff0000' },
    };
    expect(
      mapProposalsToEditIntents(
        [
          {
            id: solid.id,
            props: {
              gradient: {
                type: 'radial',
                rotate: 90,
                colors: [{ pos: 50, color: 'red' }],
              },
            },
          },
        ],
        [solid],
      ).ok,
    ).toBe(false);

    const gradient: ElementInventoryItem = {
      ...inventory[1],
      id: 'solid-gradient-to-fill',
      style: {
        fill: '#ff0000',
        gradient: { type: 'linear', rotate: 45, colors: [{ pos: 0, color: 'red' }] },
      },
    };
    expect(
      mapProposalsToEditIntents([{ id: gradient.id, props: { fill: '#ff0000' } }], [gradient]).ok,
    ).toBe(false);

    const unpainted: ElementInventoryItem = {
      ...inventory[1],
      id: 'unpainted',
      style: {},
    };
    expect(
      mapProposalsToEditIntents(
        [
          {
            id: unpainted.id,
            props: {
              gradient: {
                type: 'linear',
                rotate: 30,
                colors: [
                  { pos: 0, color: 'transparent' },
                  { pos: 100, color: 'rgba(255, 0, 0, 0)' },
                ],
              },
            },
          },
        ],
        [unpainted],
      ).ok,
    ).toBe(false);
  });

  it('normalizes renderer defaults before deciding whether an edit is visible', () => {
    const defaultCases: Array<[ElementInventoryItem, Record<string, unknown>]> = [
      [textEl({ id: 'opacity-default' }), { opacity: 1 }],
      [textEl({ id: 'rotate-default' }), { rotate: 0 }],
      [
        { ...inventory[1], id: 'shape-word-default', style: {}, hasShapeText: true },
        { wordSpace: 0 },
      ],
      [
        { ...inventory[1], id: 'shape-paragraph-default', style: {}, hasShapeText: true },
        { paragraphSpace: 5 },
      ],
      [
        { ...inventory[1], id: 'shape-align-default', style: {}, hasShapeText: true },
        { vAlign: 'middle' },
      ],
      [
        {
          id: 'image-defaults',
          type: 'image',
          left: 0,
          top: 0,
          width: 100,
          height: 100,
          rotate: 0,
          lock: false,
          label: 'image',
          imageClipShape: 'rect',
          style: {},
        },
        { flipH: false },
      ],
      [
        {
          id: 'image-filter-default',
          type: 'image',
          left: 0,
          top: 0,
          width: 100,
          height: 100,
          rotate: 0,
          lock: false,
          label: 'image',
          imageClipShape: 'rect',
          style: {},
        },
        { filters: { blur: '0', brightness: '100' } },
      ],
    ];

    for (const [item, props] of defaultCases) {
      const result = mapProposalsToEditIntents([{ id: item.id, props }], [item]);
      expect(result.ok, `${item.id} should be a visual no-op`).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/no effective change/i);
    }
  });

  it('refuses computed-equivalent rotation and image radius updates', () => {
    const rotated = [{ ...inventory[1], rotate: 360 }];
    expect(mapProposalsToEditIntents([{ id: 'fig-1', props: { rotate: 0 } }], rotated).ok).toBe(
      false,
    );

    const roundedImage: ElementInventoryItem[] = [
      {
        id: 'rounded-image',
        type: 'image',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        rotate: 0,
        lock: false,
        label: 'image',
        imageClipShape: 'roundRect',
        style: { radius: 100 },
      },
    ];
    expect(
      mapProposalsToEditIntents([{ id: 'rounded-image', props: { radius: 500 } }], roundedImage).ok,
    ).toBe(false);
  });

  it('refuses transparent chrome that has no visible effect', () => {
    const image: ElementInventoryItem = {
      id: 'transparent-image',
      type: 'image',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      lock: false,
      label: 'image',
      imageClipShape: 'rect',
      style: {},
    };
    for (const props of [
      { colorMask: 'transparent' },
      { outline: { width: 2, color: 'transparent' } },
      { shadow: { h: 1, v: 1, blur: 2, color: 'transparent' } },
    ]) {
      expect(mapProposalsToEditIntents([{ id: image.id, props }], [image]).ok).toBe(false);
    }
    expect(
      mapProposalsToEditIntents([{ id: 'title-1', props: { fill: 'transparent' } }], inventory).ok,
    ).toBe(false);
  });

  it('refuses mutually exclusive shape paint props in one update', () => {
    expect(
      mapProposalsToEditIntents(
        [
          {
            id: 'fig-1',
            props: {
              fill: '#ff0000',
              gradient: {
                type: 'linear',
                rotate: 0,
                colors: [
                  { pos: 0, color: '#ff0000' },
                  { pos: 100, color: '#0000ff' },
                ],
              },
            },
          },
        ],
        inventory,
      ).ok,
    ).toBe(false);
  });

  it('refuses latex geometry that renders inconsistently across surfaces', () => {
    const [latex] = buildElementInventory([
      {
        id: 'latex-size',
        type: 'latex',
        left: 0,
        top: 0,
        width: 100,
        height: 50,
        rotate: 0,
        latex: 'x',
        html: '<span>x</span>',
        color: '#000000',
      } as PPTElement,
    ]);
    expect(mapProposalsToEditIntents([{ id: latex.id, props: { width: 200 } }], [latex]).ok).toBe(
      false,
    );

    const [svgLatex] = buildElementInventory([
      {
        id: 'latex-svg-size',
        type: 'latex',
        left: 0,
        top: 0,
        width: 100,
        height: 50,
        rotate: 0,
        latex: 'x',
        path: 'M0 0 L10 10',
        viewBox: [10, 10],
        color: '#000000',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents([{ id: svgLatex.id, props: { width: 200 } }], [svgLatex]).ok,
    ).toBe(true);
  });

  it('refuses shape text chrome when the shape has no visible label', () => {
    const [unlabelled] = buildElementInventory([
      {
        id: 'plain-shape',
        type: 'shape',
        left: 0,
        top: 0,
        width: 100,
        height: 80,
        rotate: 0,
        viewBox: [100, 80],
        path: 'M0 0',
        fixedRatio: false,
        fill: '#ffffff',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents([{ id: unlabelled.id, props: { wordSpace: 2 } }], [unlabelled]).ok,
    ).toBe(false);
  });

  it('refuses glyph-only edits for empty or explicitly hidden text', () => {
    for (const content of [
      '<p></p>',
      '<span style="display:none">hidden</span>',
      '<p title="a > b"></p>',
      '<span style="visibility:hidden!important;visibility:visible">hidden</span>',
      '<span style="font-size:0!important;font-size:12px">hidden</span>',
    ]) {
      const [text] = buildElementInventory([
        {
          id: `empty-${content.length}`,
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
          content,
          defaultColor: '#000000',
          defaultFontName: 'Arial',
        } as PPTElement,
      ]);
      expect(
        mapProposalsToEditIntents([{ id: text.id, props: { defaultColor: '#ff0000' } }], [text]).ok,
      ).toBe(false);
      expect(mapProposalsToEditIntents([{ id: text.id, props: { opacity: 0.5 } }], [text]).ok).toBe(
        false,
      );
    }
  });

  it('keeps visible text editable when only a descendant is hidden or translucent', () => {
    for (const content of [
      '<p>visible <span style="opacity:0.5">dim</span><span style="display:none">hidden</span></p>',
      '<span style="visibility:hidden">hidden <b style="visibility:visible">shown</b></span>',
      '<span style="font-size:0">hidden <b style="font-size:12px">shown</b></span>',
      '<span style="opacity:0;opacity:1">shown</span>',
      '<span style="display:none;display:block">shown</span>',
      '<span class="hidden" style="display:block">shown</span>',
      '<span style="visibility:hidden"><b style="visibility:initial">shown</b></span>',
      '<span style="font-size:0"><b style="font-size:initial">shown</b></span>',
      '<span style="color:transparent"><b style="color:initial">shown</b></span>',
      '<span style="-webkit-text-fill-color:transparent"><b style="-webkit-text-fill-color:initial;color:red">shown</b></span>',
    ]) {
      const [text] = buildElementInventory([
        {
          id: `partly-visible-${content.length}`,
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
          content,
          defaultColor: '#000000',
          defaultFontName: 'Arial',
        } as PPTElement,
      ]);
      const props = content.includes('color:') ? { wordSpace: 4 } : { defaultColor: '#ff0000' };
      expect(mapProposalsToEditIntents([{ id: text.id, props }], [text]).ok).toBe(true);
    }
  });

  it('refuses glyph-only edits when text paint is fully transparent', () => {
    for (const content of [
      '<span style="color:transparent">x</span>',
      '<span style="-webkit-text-fill-color:rgba(255, 0, 0, 0)">x</span>',
      '<span style="color:rgba(0, 0, 0, 0%)">x</span>',
      '<span style="color:rgb(255 0 0 / 0)">x</span>',
      '<span style="color:hsl(0 100% 50% / 0%)">x</span>',
      '<span style="color:transparent!important;color:red">x</span>',
      '<span style="color:transparent"><b style="text-shadow:0 0 2px">x</b></span>',
    ]) {
      const [text] = buildElementInventory([
        {
          id: `transparent-${content.length}`,
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
          content,
          defaultColor: '#000000',
          defaultFontName: 'Arial',
        } as PPTElement,
      ]);
      expect(mapProposalsToEditIntents([{ id: text.id, props: { wordSpace: 4 } }], [text]).ok).toBe(
        false,
      );
    }
  });

  it('keeps transparent glyphs editable when a visible text shadow paints them', () => {
    const [text] = buildElementInventory([
      {
        id: 'shadow-glyph',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content: '<span style="color:transparent;text-shadow:0 0 2px red">x</span>',
        defaultColor: '#000000',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);
    expect(mapProposalsToEditIntents([{ id: text.id, props: { wordSpace: 4 } }], [text]).ok).toBe(
      true,
    );
  });

  it('applies CSS-wide resets and inherited text-shadow using the child currentColor', () => {
    const [resetVisible] = buildElementInventory([
      {
        id: 'all-reset-visible',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content: '<span style="visibility:hidden"><b style="all:initial">x</b></span>',
        defaultColor: '#000000',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);
    expect(resetVisible.hasTextGlyphs).toBe(true);

    for (const content of [
      '<span style="color:red;-webkit-text-fill-color:transparent;text-shadow:initial">x</span>',
      '<span style="color:red;text-shadow:0 0 2px"><b style="color:transparent">x</b></span>',
    ]) {
      const [hidden] = buildElementInventory([
        {
          id: `hidden-shadow-${content.length}`,
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
          content,
          defaultColor: '#000000',
          defaultFontName: 'Arial',
        } as PPTElement,
      ]);
      expect(hidden.hasTextGlyphs).toBe(false);
    }

    const [multiShadow] = buildElementInventory([
      {
        id: 'multi-shadow-visible',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content:
          '<span style="color:red;-webkit-text-fill-color:transparent;text-shadow:0 0 transparent,1px 1px currentColor">x</span>',
        defaultColor: '#000000',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);
    expect(multiShadow.hasTextGlyphs).toBe(true);

    for (const content of [
      '<span style="visibility:hidden"><b style="all:revert">x</b></span>',
      '<span style="visibility:hidden"><b style="all:red">x</b></span>',
      '<span class="invisible" style="visibility:revert-layer">x</span>',
    ]) {
      const [hidden] = buildElementInventory([
        {
          id: `revert-hidden-${content.length}`,
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
          content,
          defaultColor: '#000000',
          defaultFontName: 'Arial',
        } as PPTElement,
      ]);
      expect(hidden.hasTextGlyphs).toBe(false);
    }

    const [invalidAll] = buildElementInventory([
      {
        id: 'invalid-all-does-not-override',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content: '<span style="all:red">x</span>',
        defaultColor: '#000000',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents([{ id: invalidAll.id, props: { wordSpace: 4 } }], [invalidAll]).ok,
    ).toBe(true);

    const [revertLayerColor] = buildElementInventory([
      {
        id: 'revert-layer-color',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content: '<span style="color:revert-layer">x</span>',
        defaultColor: '#0000ff',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [{ id: revertLayerColor.id, props: { defaultColor: '#ff0000' } }],
        [revertLayerColor],
      ).ok,
    ).toBe(true);
  });

  it('ignores invalid later CSS declarations instead of replacing valid winners', () => {
    for (const content of [
      '<span style="visibility:hidden;visibility:nope">x</span>',
      '<span style="display:none;display:nope">x</span>',
      '<span style="opacity:0;opacity:nope">x</span>',
      '<span style="color:transparent;color:nope">x</span>',
      '<span style="font-size:0;font-size:nope">x</span>',
    ]) {
      const [hidden] = buildElementInventory([
        {
          id: `invalid-later-${content.length}`,
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
          content,
          defaultColor: '#000000',
          defaultFontName: 'Arial',
        } as PPTElement,
      ]);
      expect(hidden.hasTextGlyphs).toBe(false);
    }
  });

  it('includes font shorthand in computed font-size visibility', () => {
    for (const [content, visible] of [
      ['<span style="font:0 Arial">x</span>', false],
      ['<span style="font-size:0"><b style="font:initial">x</b></span>', true],
      ['<span style="font:0 Arial;font:caption">x</span>', true],
    ] as const) {
      const [text] = buildElementInventory([
        {
          id: `font-shorthand-${content.length}`,
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
          content,
          defaultColor: '#000000',
          defaultFontName: 'Arial',
        } as PPTElement,
      ]);
      expect(text.hasTextGlyphs).toBe(visible);
    }

    const [systemFont] = buildElementInventory([
      {
        id: 'system-font-override',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content: '<span style="font:caption">x</span>',
        defaultColor: '#000000',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [{ id: systemFont.id, props: { defaultFontName: 'Inter' } }],
        [systemFont],
      ).ok,
    ).toBe(false);
  });

  it('fails closed for computed CSS values it cannot fully evaluate', () => {
    for (const content of [
      '<span style="opacity:calc(0)">x</span>',
      '<span style="font-size:calc(0px)">x</span>',
      '<span style="color:color-mix(in srgb, transparent 100%, red 0%)">x</span>',
    ]) {
      const [hidden] = buildElementInventory([
        {
          id: `computed-hidden-${content.length}`,
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
          content,
          defaultColor: '#000000',
          defaultFontName: 'Arial',
        } as PPTElement,
      ]);
      expect(hidden.hasTextGlyphs).toBe(false);
    }

    const [visibleDisplay] = buildElementInventory([
      {
        id: 'multi-keyword-display',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content: '<span style="display:none;display:inline flex">x</span>',
        defaultColor: '#000000',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);
    expect(visibleDisplay.hasTextGlyphs).toBe(true);
    for (const display of ['block list-item', 'inline list-item', 'flow-root list-item']) {
      const [listItem] = buildElementInventory([
        {
          id: `list-item-${display}`,
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
          content: `<span style="display:none;display:${display}">x</span>`,
          defaultColor: '#000000',
          defaultFontName: 'Arial',
        } as PPTElement,
      ]);
      expect(listItem.hasTextGlyphs).toBe(true);
    }
    for (const display of ['flex list-item', 'table list-item', 'ruby list-item']) {
      const [invalidListItem] = buildElementInventory([
        {
          id: `invalid-list-item-${display}`,
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
          content: `<span style="display:none;display:${display}">x</span>`,
          defaultColor: '#000000',
          defaultFontName: 'Arial',
        } as PPTElement,
      ]);
      expect(invalidListItem.hasTextGlyphs).toBe(false);
    }
  });

  it('recognizes unitless-zero text shadows as inline overrides', () => {
    const [text] = buildElementInventory([
      {
        id: 'unitless-shadow',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content: '<span style="text-shadow:0 0">x</span>',
        defaultColor: '#000000',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [{ id: text.id, props: { shadow: { h: 1, v: 1, blur: 2, color: 'red' } } }],
        [text],
      ).ok,
    ).toBe(false);

    const [invalid] = buildElementInventory([
      {
        id: 'invalid-one-length-shadow',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content: '<span style="text-shadow:0">x</span>',
        defaultColor: '#000000',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [{ id: invalid.id, props: { shadow: { h: 1, v: 1, blur: 2, color: 'red' } } }],
        [invalid],
      ).ok,
    ).toBe(true);

    const [tooManyColors] = buildElementInventory([
      {
        id: 'invalid-two-color-shadow',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content: '<span style="text-shadow:red blue 0 0">x</span>',
        defaultColor: '#000000',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [{ id: tooManyColors.id, props: { shadow: { h: 1, v: 1, blur: 2, color: 'red' } } }],
        [tooManyColors],
      ).ok,
    ).toBe(true);
  });

  it('fails closed for unresolved or modern text-shadow colors', () => {
    for (const shadow of [
      'var(--missing)',
      'var(--missing, none)',
      '0 0 color-mix(in srgb, transparent 100%, red 0%)',
    ]) {
      const [text] = buildElementInventory([
        {
          id: `unresolved-shadow-${shadow.length}`,
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
          content: `<span style="-webkit-text-fill-color:transparent;text-shadow:${shadow}">x</span>`,
          defaultColor: '#000000',
          defaultFontName: 'Arial',
        } as PPTElement,
      ]);
      expect(text.hasTextGlyphs).toBe(false);
    }
  });

  it('includes element-level text paint in glyph visibility and composed shadow edits', () => {
    const base = {
      type: 'text',
      left: 0,
      top: 0,
      width: 100,
      height: 40,
      rotate: 0,
      content: 'x',
      defaultFontName: 'Arial',
    };
    const [transparent] = buildElementInventory([
      { ...base, id: 'root-transparent', defaultColor: 'transparent' } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents([{ id: transparent.id, props: { wordSpace: 4 } }], [transparent])
        .ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents(
        [
          {
            id: transparent.id,
            props: { shadow: { h: 1, v: 1, blur: 2, color: '#ff0000' } },
          },
        ],
        [transparent],
      ).ok,
    ).toBe(true);

    const [shadowVisible] = buildElementInventory([
      {
        ...base,
        id: 'root-shadow-visible',
        content: '<span style="-webkit-text-fill-color:transparent">x</span>',
        defaultColor: '#ff0000',
        shadow: { h: 1, v: 1, blur: 2, color: '#ff0000' },
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [{ id: shadowVisible.id, props: { wordSpace: 4 } }],
        [shadowVisible],
      ).ok,
    ).toBe(true);

    for (const content of [
      '<span style="-webkit-text-fill-color:initial">x</span>',
      '<span style="-webkit-text-fill-color:currentColor">x</span>',
      '<span style="-webkit-text-fill-color:transparent;text-shadow:0 0 2px currentColor">x</span>',
    ]) {
      const [colorDependent] = buildElementInventory([
        {
          ...base,
          id: `root-color-dependent-${content.length}`,
          content,
          defaultColor: 'transparent',
        } as PPTElement,
      ]);
      expect(
        mapProposalsToEditIntents(
          [{ id: colorDependent.id, props: { defaultColor: '#ff0000' } }],
          [colorDependent],
        ).ok,
      ).toBe(true);
    }

    const [shadowDependent] = buildElementInventory([
      {
        ...base,
        id: 'root-shadow-dependent',
        content: '<span style="text-shadow:inherit">x</span>',
        defaultColor: 'transparent',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [
          {
            id: shadowDependent.id,
            props: { shadow: { h: 1, v: 1, blur: 2, color: '#ff0000' } },
          },
        ],
        [shadowDependent],
      ).ok,
    ).toBe(true);
  });

  it('treats element opacity zero as unpainted while allowing a composed reveal', () => {
    const [text] = buildElementInventory([
      {
        id: 'root-opacity-zero',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        opacity: 0,
        content: 'x',
        defaultColor: '#000000',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);
    expect(mapProposalsToEditIntents([{ id: text.id, props: { wordSpace: 4 } }], [text]).ok).toBe(
      false,
    );
    expect(
      mapProposalsToEditIntents([{ id: text.id, props: { opacity: 1, wordSpace: 4 } }], [text]).ok,
    ).toBe(true);

    const [transparent] = buildElementInventory([
      {
        id: 'root-opacity-and-color-zero',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        opacity: 0,
        content: 'x',
        defaultColor: 'transparent',
        defaultFontName: 'Arial',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [{ id: transparent.id, props: { shadow: { h: 1, v: 1, blur: 2, color: 'red' } } }],
        [transparent],
      ).ok,
    ).toBe(false);
    for (const paint of [
      { defaultColor: '#ff0000' },
      { shadow: { h: 1, v: 1, blur: 2, color: '#ff0000' } },
    ]) {
      expect(
        mapProposalsToEditIntents(
          [{ id: transparent.id, props: { ...paint, opacity: 1, wordSpace: 4 } }],
          [transparent],
        ).ok,
      ).toBe(true);
    }
  });

  it('evaluates empty text box paint from the composed proposal', () => {
    const base = {
      type: 'text',
      left: 0,
      top: 0,
      width: 100,
      height: 40,
      rotate: 0,
      opacity: 0,
      content: '',
      defaultColor: 'transparent',
      defaultFontName: 'Arial',
    };
    const [empty] = buildElementInventory([{ ...base, id: 'empty-box' } as PPTElement]);
    expect(
      mapProposalsToEditIntents([{ id: empty.id, props: { opacity: 1, fill: '#ff0000' } }], [empty])
        .ok,
    ).toBe(true);
    expect(
      mapProposalsToEditIntents([{ id: empty.id, props: { fill: '#ff0000' } }], [empty]).ok,
    ).toBe(false);

    for (const element of [
      { ...base, id: 'cancel-fill', fill: '#ff0000' },
      {
        ...base,
        id: 'cancel-outline',
        outline: { width: 2, color: '#ff0000', style: 'solid' },
      },
    ]) {
      const [item] = buildElementInventory([element as PPTElement]);
      const paintRemoval =
        element.id === 'cancel-fill' ? { fill: 'transparent' } : { outline: { width: 0 } };
      expect(
        mapProposalsToEditIntents([{ id: item.id, props: { opacity: 1, ...paintRemoval } }], [item])
          .ok,
      ).toBe(false);
    }

    for (const paintRemoval of [{ opacity: 0 }, { fill: 'transparent' }]) {
      const [visible] = buildElementInventory([
        {
          ...base,
          id: `remove-box-${Object.keys(paintRemoval)[0]}`,
          opacity: 1,
          fill: 'red',
        } as PPTElement,
      ]);
      expect(
        mapProposalsToEditIntents([{ id: visible.id, props: paintRemoval }], [visible]).ok,
      ).toBe(true);
    }

    const [glyphReveal] = buildElementInventory([
      {
        ...base,
        id: 'glyph-reveal-outline-no-width',
        opacity: 1,
        content: 'x',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [
          {
            id: glyphReveal.id,
            props: { defaultColor: 'red', outline: { color: 'red' } },
          },
        ],
        [glyphReveal],
      ).ok,
    ).toBe(false);
  });

  it('rejects mutually cancelling paint changes on shapes and invisible line edits', () => {
    const shape = {
      id: 'cancel-shape-paint',
      type: 'shape',
      left: 0,
      top: 0,
      width: 100,
      height: 80,
      rotate: 0,
      viewBox: [100, 80],
      path: 'M0 0 H100 V80 H0 Z',
      fixedRatio: false,
      fill: 'red',
      opacity: 0,
    } as PPTElement;
    const [shapeItem] = buildElementInventory([shape]);
    expect(
      mapProposalsToEditIntents(
        [{ id: shape.id, props: { opacity: 1, fill: 'transparent' } }],
        [shapeItem],
      ).ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents([{ id: shape.id, props: { opacity: 1, fill: 'red' } }], [shapeItem])
        .ok,
    ).toBe(true);

    const line = {
      id: 'transparent-line',
      type: 'line',
      left: 0,
      top: 0,
      width: 2,
      start: [0, 0],
      end: [100, 0],
      style: 'solid',
      color: 'transparent',
      points: ['', ''],
    } as unknown as PPTElement;
    const [lineItem] = buildElementInventory([line]);
    expect(mapProposalsToEditIntents([{ id: line.id, props: { left: 10 } }], [lineItem]).ok).toBe(
      false,
    );
    expect(
      mapProposalsToEditIntents([{ id: line.id, props: { color: 'red' } }], [lineItem]).ok,
    ).toBe(true);
    for (const invisibleLine of [
      { ...line, id: 'zero-width-line', width: 0, color: 'red' },
      {
        ...line,
        id: 'zero-length-line',
        width: 2,
        color: 'red',
        start: [0, 0],
        end: [0, 0],
      },
    ]) {
      const [item] = buildElementInventory([invisibleLine as PPTElement]);
      expect(mapProposalsToEditIntents([{ id: item.id, props: { left: 10 } }], [item]).ok).toBe(
        false,
      );
    }

    for (const control of [
      { broken: [50, 50] },
      { broken2: [50, 50] },
      { curve: [50, 50] },
      {
        cubic: [
          [25, 50],
          [75, 50],
        ],
      },
    ]) {
      const controlledLine = {
        ...line,
        id: `controlled-line-${Object.keys(control)[0]}`,
        color: 'red',
        start: [0, 0],
        end: [0, 0],
        ...control,
      } as unknown as PPTElement;
      const [item] = buildElementInventory([controlledLine]);
      expect(mapProposalsToEditIntents([{ id: item.id, props: { left: 10 } }], [item]).ok).toBe(
        true,
      );
    }

    const rendererZeroBroken2 = {
      ...line,
      id: 'renderer-zero-broken2',
      color: 'red',
      start: [10, 20],
      end: [10, 20],
      broken2: [50, 20],
    } as unknown as PPTElement;
    const [rendererZeroBroken2Item] = buildElementInventory([rendererZeroBroken2]);
    expect(
      mapProposalsToEditIntents(
        [{ id: rendererZeroBroken2.id, props: { left: 10 } }],
        [rendererZeroBroken2Item],
      ).ok,
    ).toBe(false);
    const priorityDegenerateLine = {
      ...line,
      id: 'priority-degenerate-line',
      color: 'red',
      start: [0, 0],
      end: [0, 0],
      broken: [0, 0],
      broken2: [50, 50],
      curve: [50, 50],
      cubic: [
        [25, 50],
        [75, 50],
      ],
    } as unknown as PPTElement;
    const [priorityDegenerateItem] = buildElementInventory([priorityDegenerateLine]);
    expect(
      mapProposalsToEditIntents(
        [{ id: priorityDegenerateLine.id, props: { left: 10 } }],
        [priorityDegenerateItem],
      ).ok,
    ).toBe(false);

    const emptyShape = { ...shape, id: 'empty-fill-shape', fill: '', opacity: 1 } as PPTElement;
    const [emptyShapeItem] = buildElementInventory([emptyShape]);
    expect(
      mapProposalsToEditIntents([{ id: emptyShape.id, props: { left: 20 } }], [emptyShapeItem]).ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents(
        [{ id: emptyShape.id, props: { fill: '#ff0000' } }],
        [emptyShapeItem],
      ).ok,
    ).toBe(true);

    const [emptyText] = buildElementInventory([
      {
        id: 'empty-fill-text',
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content: '',
        defaultColor: 'transparent',
        defaultFontName: 'Arial',
        fill: '',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents([{ id: emptyText.id, props: { left: 20 } }], [emptyText]).ok,
    ).toBe(false);
  });

  it('does not treat an empty shape pattern as visible paint', () => {
    const [shape] = buildElementInventory([
      {
        id: 'empty-pattern',
        type: 'shape',
        left: 0,
        top: 0,
        width: 100,
        height: 80,
        rotate: 0,
        viewBox: [100, 80],
        path: 'M0 0',
        fixedRatio: false,
        fill: '#ff0000',
        pattern: '',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents([{ id: shape.id, props: { fill: '#ff0000' } }], [shape]).ok,
    ).toBe(false);
  });

  it('allows composed color reveals for transparent shape labels and latex HTML', () => {
    const shape = {
      id: 'transparent-shape-label',
      type: 'shape',
      left: 0,
      top: 0,
      width: 100,
      height: 80,
      rotate: 0,
      viewBox: [100, 80],
      path: 'M0 0 H100 V80 H0 Z',
      fixedRatio: false,
      fill: 'transparent',
      text: {
        content: 'Label',
        defaultColor: 'transparent',
        defaultFontName: 'Arial',
      },
    } as PPTElement;
    const [shapeItem] = buildElementInventory([shape]);
    expect(
      mapProposalsToEditIntents([{ id: shape.id, props: { defaultColor: '#ff0000' } }], [shapeItem])
        .ok,
    ).toBe(true);

    const latex = {
      id: 'transparent-latex-html',
      type: 'latex',
      left: 0,
      top: 0,
      width: 100,
      height: 50,
      rotate: 0,
      latex: 'x',
      html: '<span>x</span>',
      color: 'transparent',
    } as PPTElement;
    const [latexItem] = buildElementInventory([latex]);
    expect(
      mapProposalsToEditIntents([{ id: latex.id, props: { color: '#ff0000' } }], [latexItem]).ok,
    ).toBe(true);
  });

  it('fails closed when inline KaTeX color would override latex color', () => {
    const [latex] = buildElementInventory([
      {
        id: 'latex-colored',
        type: 'latex',
        left: 0,
        top: 0,
        width: 100,
        height: 50,
        rotate: 0,
        latex: String.raw`\color{blue}{x}`,
        html: '<span style="color: blue">x</span>',
        color: '#000000',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents([{ id: latex.id, props: { color: '#ff0000' } }], [latex]).ok,
    ).toBe(false);
  });

  it('refuses color edits for latex elements with no renderable branch', () => {
    const [latex] = buildElementInventory([
      {
        id: 'latex-empty',
        type: 'latex',
        left: 0,
        top: 0,
        width: 100,
        height: 50,
        rotate: 0,
        latex: 'x',
        color: '#000000',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents([{ id: latex.id, props: { color: '#ff0000' } }], [latex]).ok,
    ).toBe(false);
    expect(mapProposalsToEditIntents([{ id: latex.id, props: { left: 20 } }], [latex]).ok).toBe(
      false,
    );
  });

  it('uses renderer-specific table and chart capability constraints', () => {
    const tableBase = {
      id: 'table-1',
      type: 'table',
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      rotate: 0,
      data: [[{ id: 'cell-1', text: 'x', borders: { top: { color: '#000000', width: 1 } } }]],
      colWidths: [1],
      cellMinHeight: 36,
      outline: { color: '#000000' },
    } as unknown as PPTElement;
    const [borderedTable] = buildElementInventory([tableBase]);
    expect(
      mapProposalsToEditIntents(
        [{ id: borderedTable.id, props: { outline: { color: '#ff0000' } } }],
        [borderedTable],
      ).ok,
    ).toBe(false);

    const [plainTable] = buildElementInventory([
      { ...tableBase, id: 'plain-table', data: [[{ id: 'cell-1', text: 'x' }]] } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [{ id: plainTable.id, props: { outline: { color: '#ff0000' } } }],
        [plainTable],
      ).ok,
    ).toBe(true);
    expect(
      mapProposalsToEditIntents(
        [{ id: plainTable.id, props: { outline: { style: 'dotted' } } }],
        [plainTable],
      ).ok,
    ).toBe(false);

    for (const chartType of ['pie', 'ring']) {
      const [chart] = buildElementInventory([
        {
          id: `chart-${chartType}`,
          type: 'chart',
          chartType,
          left: 0,
          top: 0,
          width: 200,
          height: 100,
          rotate: 0,
          data: { labels: ['A'], legends: ['S'], series: [[1]] },
          themeColors: ['#000000'],
          lineColor: '#000000',
        } as PPTElement,
      ]);
      expect(
        mapProposalsToEditIntents([{ id: chart.id, props: { lineColor: '#ff0000' } }], [chart]).ok,
      ).toBe(false);
    }
    const [emptyChart] = buildElementInventory([
      {
        id: 'empty-chart',
        type: 'chart',
        chartType: 'bar',
        left: 0,
        top: 0,
        width: 200,
        height: 100,
        rotate: 0,
        data: { labels: [], legends: [], series: [] },
        themeColors: ['#000000'],
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [{ id: emptyChart.id, props: { themeColors: ['#ff0000'] } }],
        [emptyChart],
      ).ok,
    ).toBe(false);

    const [singleSlice] = buildElementInventory([
      {
        id: 'single-slice',
        type: 'chart',
        chartType: 'pie',
        left: 0,
        top: 0,
        width: 200,
        height: 100,
        rotate: 0,
        data: { labels: ['A'], legends: ['S'], series: [[1]] },
        themeColors: ['#ff0000', '#0000ff'],
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [{ id: singleSlice.id, props: { themeColors: ['#ff0000', '#00ff00'] } }],
        [singleSlice],
      ).ok,
    ).toBe(false);

    const [scatter] = buildElementInventory([
      {
        id: 'scatter',
        type: 'chart',
        chartType: 'scatter',
        left: 0,
        top: 0,
        width: 200,
        height: 100,
        rotate: 0,
        data: { labels: ['A'], legends: ['S'], series: [[1], [2]] },
        themeColors: ['#ff0000', '#0000ff'],
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [{ id: scatter.id, props: { themeColors: ['#ff0000', '#00ff00'] } }],
        [scatter],
      ).ok,
    ).toBe(false);

    const [singleSeriesScatter] = buildElementInventory([
      {
        id: 'single-series-scatter',
        type: 'chart',
        chartType: 'scatter',
        left: 0,
        top: 0,
        width: 200,
        height: 100,
        rotate: 0,
        data: { labels: ['A'], legends: ['S'], series: [[1, 2]] },
        themeColors: ['#ff0000'],
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [{ id: singleSeriesScatter.id, props: { themeColors: ['#00ff00'] } }],
        [singleSeriesScatter],
      ).ok,
    ).toBe(true);

    const [emptySeriesChart] = buildElementInventory([
      {
        id: 'empty-series',
        type: 'chart',
        chartType: 'bar',
        left: 0,
        top: 0,
        width: 200,
        height: 100,
        rotate: 0,
        data: { labels: [], legends: ['S'], series: [[]] },
        themeColors: ['#ff0000'],
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [{ id: emptySeriesChart.id, props: { themeColors: ['#00ff00'] } }],
        [emptySeriesChart],
      ).ok,
    ).toBe(false);

    const [emptyPie] = buildElementInventory([
      {
        id: 'empty-pie',
        type: 'chart',
        chartType: 'pie',
        left: 0,
        top: 0,
        width: 200,
        height: 100,
        rotate: 0,
        data: { labels: [], legends: [], series: [[]] },
        themeColors: ['#ff0000'],
        textColor: '#000000',
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents([{ id: emptyPie.id, props: { textColor: '#ff0000' } }], [emptyPie])
        .ok,
    ).toBe(false);

    const [threeSeries] = buildElementInventory([
      {
        id: 'three-series',
        type: 'chart',
        chartType: 'bar',
        left: 0,
        top: 0,
        width: 200,
        height: 100,
        rotate: 0,
        data: { labels: ['A'], legends: ['A', 'B', 'C'], series: [[1], [2], [3]] },
        themeColors: ['#ff0000'],
      } as PPTElement,
    ]);
    expect(
      mapProposalsToEditIntents(
        [
          {
            id: threeSeries.id,
            props: { themeColors: ['rgb(255, 0, 0)', 'rgb(255, 0, 204)', 'rgb(255, 0, 153)'] },
          },
        ],
        [threeSeries],
      ).ok,
    ).toBe(false);
  });

  it('fails closed for CSS shorthands and inherited override aliases', () => {
    const rawText = (id: string, content: string) =>
      ({
        id,
        type: 'text',
        left: 0,
        top: 0,
        width: 300,
        height: 60,
        rotate: 0,
        content,
        defaultFontName: 'Arial',
        defaultColor: '#111111',
      }) as PPTElement;
    const cases: Array<[string, string, Record<string, unknown>]> = [
      [
        'font-family',
        '<span style="font: italic 16px/1.8 Calibri">x</span>',
        { defaultFontName: 'Inter' },
      ],
      [
        'font-line-height',
        '<span style="font: italic 16px/1.8 Calibri">x</span>',
        { lineHeight: 1.5 },
      ],
      ['margin', '<p style="margin: 0 0 12pt">x</p>', { paragraphSpace: 5 }],
      [
        'vendor-color',
        '<span style="-webkit-text-fill-color: red">x</span>',
        { defaultColor: '#0000ff' },
      ],
      ['writing-mode', '<span style="writing-mode: horizontal-tb">x</span>', { vertical: true }],
      [
        'text-shadow',
        '<span style="text-shadow: 1px 1px #000">x</span>',
        { shadow: { h: 2, v: 2, blur: 2, color: '#000000' } },
      ],
      ['all', '<span style="all: initial">x</span>', { wordSpace: 4 }],
    ];

    for (const [id, content, props] of cases) {
      const item = buildElementInventory([rawText(id, content)]);
      const result = mapProposalsToEditIntents([{ id, props }], item);
      expect(result.ok, id).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/inline/i);
    }
  });

  it('refuses invalid CSS colors across top-level and nested color contracts', () => {
    expect(
      mapProposalsToEditIntents(
        [{ id: 'title-1', props: { defaultColor: 'definitely-not-a-color' } }],
        inventory,
      ).ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents(
        [{ id: 'title-1', props: { outline: { width: 2, color: 'not-a-color' } } }],
        inventory,
      ).ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents(
        [
          {
            id: 'fig-1',
            props: {
              gradient: {
                type: 'linear',
                colors: [
                  { pos: 0, color: '#000000' },
                  { pos: 100, color: 'invalid-gradient-color' },
                ],
                rotate: 0,
              },
            },
          },
        ],
        inventory,
      ).ok,
    ).toBe(false);
  });

  it('refuses empty or visually ineffective nested style patches', () => {
    const image: ElementInventoryItem = {
      id: 'img-1',
      type: 'image',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      lock: false,
      label: 'image',
      style: {},
    };

    for (const props of [{ outline: {} }, { outline: { color: '#ff0000' } }, { filters: {} }]) {
      expect(mapProposalsToEditIntents([{ id: 'img-1', props }], [image]).ok).toBe(false);
    }
    expect(
      mapProposalsToEditIntents(
        [{ id: 'img-1', props: { outline: { width: 2, color: '#ff0000' } } }],
        [image],
      ).ok,
    ).toBe(true);
  });

  it('rejects image radius when the active clip cannot render it', () => {
    const image = (shape: string, radius?: number): ElementInventoryItem => ({
      id: `img-${shape}`,
      type: 'image',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      lock: false,
      label: 'image',
      style: radius === undefined ? {} : { radius },
      imageClipShape: shape,
    });

    expect(
      mapProposalsToEditIntents([{ id: 'img-ellipse', props: { radius: 20 } }], [image('ellipse')])
        .ok,
    ).toBe(false);
    expect(
      mapProposalsToEditIntents(
        [{ id: 'img-roundRect', props: { radius: 0 } }],
        [image('roundRect')],
      ).ok,
    ).toBe(true);
    expect(
      mapProposalsToEditIntents([{ id: 'img-rect', props: { radius: 0 } }], [image('rect')]).ok,
    ).toBe(false);
  });

  it('refuses proposals that do not change effective element state', () => {
    expect(
      mapProposalsToEditIntents([{ id: 'title-1', props: { defaultColor: '#333333' } }], inventory)
        .ok,
    ).toBe(false);
  });
});
