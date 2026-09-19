import { describe, expect, it } from 'vitest';

import {
  ELEMENT_SNAPSHOT_MAX,
  ELEMENT_REF_LABEL_MAX,
  ELEMENT_REF_SELECTOR_MAX,
  INTERACTIVE_OUTERHTML_MAX,
  MAX_ELEMENT_REFS,
  addElementRef,
  elementRefLabel,
  elementRefOrdinal,
  elementSnapshotText,
  makeElementRef,
  makeInteractiveElementRef,
  decodeElementRefs,
  parseElementRefs,
  removeElementRef,
  toggleElementRef,
  type ElementRef,
} from '@/lib/workbench/element-refs';

/** The label/snapshot helpers take a translator; echo the key so it is visible. */
const t = (key: string) => key;

function ref(elementId: string, sceneId = 'scene-1', stageId = 'stage-1'): ElementRef {
  return {
    kind: 'slide-element',
    stageId,
    sceneId,
    elementId,
    elementType: 'text',
    label: `edit.element.text · ${elementId}`,
  };
}

function interactiveRef(selector = '#cta', sceneId = 'scene-web'): ElementRef {
  return {
    kind: 'interactive-element',
    stageId: 'stage-1',
    sceneId,
    selector,
    outerHTML: '<button id="cta">开始</button>',
    text: '开始',
    label: 'button · 开始',
  };
}

function slideId(value: ElementRef | undefined): string | undefined {
  return value?.kind === 'slide-element' ? value.elementId : undefined;
}

describe('element ref text extraction', () => {
  it('reads each element type from the field that actually holds its text', () => {
    // The per-type source fields mirror the server's `inventorySlide`, so a chip
    // and the inventory the agent reads name the same element the same way.
    expect(elementSnapshotText({ type: 'text', content: '<p>光的<b>折射</b></p>' })).toBe(
      '光的 折射',
    );
    expect(elementSnapshotText({ type: 'shape', text: { content: '<p>结论</p>' } })).toBe('结论');
    expect(elementSnapshotText({ type: 'latex', latex: 'n_1\\sin\\theta_1' })).toBe(
      'n_1\\sin\\theta_1',
    );
    expect(
      elementSnapshotText({
        type: 'code',
        lines: [{ content: 'const n = 1.5;' }, { content: 'return n;' }],
      }),
    ).toBe('const n = 1.5;\nreturn n;');
    expect(
      elementSnapshotText({
        type: 'table',
        data: [
          [{ text: '介质' }, { text: '折射率' }],
          [{ text: '水' }, { text: '1.33' }],
        ],
      }),
    ).toBe('介质 | 折射率 | 水 | 1.33');
  });

  it('leaves media elements without text rather than inventing any', () => {
    expect(elementSnapshotText({ type: 'image', src: 'blob:x' })).toBe('');
    expect(elementSnapshotText({ type: 'chart' })).toBe('');
  });

  it('caps the snapshot so a whole paragraph cannot ride along', () => {
    const long = elementSnapshotText({ type: 'text', content: `<p>${'字'.repeat(400)}</p>` });
    expect(long).toHaveLength(ELEMENT_SNAPSHOT_MAX);
  });
});

describe('element ref labels', () => {
  it('names the type, and adds a snippet whenever the element has text', () => {
    expect(elementRefLabel({ type: 'text', content: '<p>折射定律</p>' }, t)).toBe(
      'edit.element.text · 折射定律',
    );
    // The regression this fixes: a shape / table / code / formula used to degrade
    // to its bare type noun because only `content` was read.
    expect(elementRefLabel({ type: 'shape', text: { content: '<p>入射角</p>' } }, t)).toBe(
      'edit.element.shape · 入射角',
    );
    expect(elementRefLabel({ type: 'latex', latex: 'e^{i\\pi}' }, t)).toBe(
      'edit.element.latex · e^{i\\pi}',
    );
    expect(elementRefLabel({ type: 'image' }, t)).toBe('edit.element.image');
  });

  it('falls back to the raw type string for a type it does not know', () => {
    expect(elementRefLabel({ type: 'sticker' }, t)).toBe('sticker');
  });

  it('builds a ref only for an element that has an id', () => {
    expect(
      makeElementRef('stage-1', 'scene-1', { type: 'text', content: '<p>hi</p>' }, t),
    ).toBeNull();
    expect(
      makeElementRef('stage-1', 'scene-1', { id: 'el-1', type: 'text', content: '<p>hi</p>' }, t),
    ).toEqual({
      kind: 'slide-element',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      elementId: 'el-1',
      elementType: 'text',
      label: 'edit.element.text · hi',
      snapshotText: 'hi',
    });
  });

  it('omits snapshotText entirely when the element has none', () => {
    const made = makeElementRef('stage-1', 'scene-1', { id: 'img-1', type: 'image' }, t);
    expect(made).not.toBeNull();
    expect(made && 'snapshotText' in made).toBe(false);
  });

  it('builds a bounded interactive ref label from the picked tag and text', () => {
    expect(
      makeInteractiveElementRef(
        'stage-1',
        'scene-web',
        { selector: '#cta', outerHTML: '<button id="cta">开始</button>', text: '开始' },
        t,
      ),
    ).toEqual(interactiveRef());
  });
});

describe('element ref list operations', () => {
  it('de-duplicates by stage + scene + element, keeping array identity when nothing changed', () => {
    const list = [ref('el-1')];
    expect(addElementRef(list, ref('el-1'))).toBe(list);
    // Same element id in a DIFFERENT scene is a different element.
    expect(addElementRef(list, ref('el-1', 'scene-2'))).toHaveLength(2);
    // A cloned course may preserve both ids; stage identity keeps it distinct.
    expect(addElementRef(list, ref('el-1', 'scene-1', 'stage-2'))).toHaveLength(2);
  });

  it('stops at the cap instead of silently dropping the oldest', () => {
    let list: ElementRef[] = [];
    for (let i = 0; i < MAX_ELEMENT_REFS + 3; i += 1) list = addElementRef(list, ref(`el-${i}`));
    expect(list).toHaveLength(MAX_ELEMENT_REFS);
    // The cap keeps the EARLIEST picks; a silent eviction would make a staged
    // element vanish from the composer with no user action behind it.
    expect(slideId(list[0])).toBe('el-0');
    expect(slideId(list.at(-1))).toBe(`el-${MAX_ELEMENT_REFS - 1}`);
  });

  it('toggles: a second pick of the same element un-picks it', () => {
    const once = toggleElementRef([], ref('el-1'));
    expect(once).toHaveLength(1);
    expect(toggleElementRef(once, ref('el-1'))).toHaveLength(0);
  });

  it('removes by identity and keeps array identity for a miss', () => {
    const list = [ref('el-1'), ref('el-2')];
    expect(removeElementRef(list, 'stage-1', 'scene-1', 'el-2')).toHaveLength(1);
    expect(removeElementRef(list, 'stage-1', 'scene-1', 'el-9')).toBe(list);
    expect(removeElementRef(list, 'stage-1', 'scene-9', 'el-1')).toBe(list);
  });

  it('numbers refs from 1, and reports 0 for one that is not staged', () => {
    const list = [ref('el-1'), ref('el-2')];
    expect(elementRefOrdinal(list, 'stage-1', 'scene-1', 'el-1')).toBe(1);
    expect(elementRefOrdinal(list, 'stage-1', 'scene-1', 'el-2')).toBe(2);
    expect(elementRefOrdinal(list, 'stage-1', 'scene-1', 'el-3')).toBe(0);
  });
});

describe('parseElementRefs', () => {
  it('folds an absent or non-array field to nothing', () => {
    expect(parseElementRefs(undefined)).toEqual([]);
    expect(parseElementRefs(null)).toEqual([]);
    expect(parseElementRefs('scene-1:el-1')).toEqual([]);
  });

  it('drops entries missing any part of a ref identity', () => {
    expect(
      parseElementRefs([{ sceneId: 'scene-1' }, { elementId: 'el-1' }, null, 7, { kind: 'x' }]),
    ).toEqual([]);
  });

  it('keeps only fully well-formed wire refs', () => {
    expect(
      parseElementRefs([
        {
          kind: 'slide-element',
          stageId: 'stage-1',
          sceneId: 'scene-1',
          elementId: 'el-1',
          elementType: 'shape',
          label: '形状 · 结论',
        },
        { stageId: 'stage-1', sceneId: 'scene-1', elementId: 'el-2' },
      ]),
    ).toEqual([
      {
        kind: 'slide-element',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        elementId: 'el-1',
        elementType: 'shape',
        label: '形状 · 结论',
      },
    ]);
  });

  it('de-duplicates replay refs by full identity and keeps the first item', () => {
    const first = ref('el-1');
    expect(parseElementRefs([first, { ...first, label: 'later duplicate' }])).toEqual([first]);
  });

  it('drops wrong kind, long strings, arrays and unknown fields during replay', () => {
    const valid = ref('valid');
    expect(
      parseElementRefs([
        { ...valid, kind: 'shape-element' },
        { ...valid, elementId: 'x'.repeat(65) },
        [valid],
        { ...valid, surprise: true },
        valid,
      ]),
    ).toEqual([valid]);
  });

  it('keeps the first ten valid replay refs even when invalid entries are interleaved', () => {
    const input = Array.from({ length: 14 }, (_, index) =>
      index % 4 === 0 ? { ...ref(`bad-${index}`), kind: 'bad' } : ref(`el-${index}`),
    );
    const parsed = parseElementRefs(input);
    expect(parsed).toHaveLength(10);
    expect(parsed.map(slideId)).toEqual(
      input
        .filter((item) => item.kind === 'slide-element')
        .slice(0, 10)
        .map((item) => ('elementId' in item ? item.elementId : undefined)),
    );
  });

  it('strictly decodes the interactive variant', () => {
    expect(decodeElementRefs([interactiveRef()])).toEqual({
      ok: true,
      refs: [interactiveRef()],
    });
  });

  it.each([
    ['selector', 'x'.repeat(ELEMENT_REF_SELECTOR_MAX + 1)],
    ['outerHTML', 'x'.repeat(INTERACTIVE_OUTERHTML_MAX + 1)],
    ['text', 'x'.repeat(ELEMENT_SNAPSHOT_MAX + 1)],
    ['label', 'x'.repeat(ELEMENT_REF_LABEL_MAX + 1)],
  ] as const)('rejects and replay-drops an overlong interactive %s', (field, value) => {
    const invalid = { ...interactiveRef(), [field]: value };
    expect(decodeElementRefs([invalid])).toMatchObject({ ok: false });
    expect(decodeElementRefs([invalid], 'drop')).toEqual({ ok: true, refs: [] });
  });

  it('drops unknown kinds during replay and de-duplicates interactive selectors', () => {
    const first = interactiveRef('#same');
    expect(
      decodeElementRefs(
        [{ ...first, kind: 'dom-element' }, first, { ...first, label: 'later duplicate' }],
        'drop',
      ),
    ).toEqual({ ok: true, refs: [first] });
  });

  it('shares the capacity limit across slide and interactive refs', () => {
    const refs = [ref('slide-0')].concat(
      Array.from({ length: MAX_ELEMENT_REFS }, (_, index) => interactiveRef(`#item-${index}`)),
    );
    expect(decodeElementRefs(refs)).toMatchObject({
      ok: false,
      error: `elementRefs cannot contain more than ${MAX_ELEMENT_REFS} items`,
    });
    expect(decodeElementRefs(refs, 'drop')).toMatchObject({
      ok: true,
      refs: expect.any(Array),
    });
    const dropped = decodeElementRefs(refs, 'drop');
    expect(dropped.ok && dropped.refs).toHaveLength(MAX_ELEMENT_REFS);
  });
});
