import type { PPTElement, PPTShapeElement, PPTTextElement } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';
import { mapElementJsonPatchToEditIntents } from '@/lib/agent/tools/edit-elements-patch';

function textElement(overrides: Partial<PPTTextElement> = {}): PPTTextElement {
  return {
    id: 'title',
    type: 'text',
    left: 100,
    top: 80,
    width: 400,
    height: 80,
    rotate: 0,
    content: '<p>Old title</p>',
    defaultFontName: 'Inter',
    defaultColor: '#111111',
    lineHeight: 1.5,
    ...overrides,
  };
}

function shapeElement(overrides: Partial<PPTShapeElement> = {}): PPTShapeElement {
  return {
    id: 'shape-1',
    type: 'shape',
    left: 50,
    top: 50,
    width: 200,
    height: 100,
    rotate: 0,
    fixedRatio: false,
    viewBox: [200, 100],
    path: 'M 0 0 L 200 0 L 200 100 L 0 100 Z',
    fill: '#ffffff',
    text: {
      content: '<p>Old label</p>',
      defaultFontName: 'Inter',
      defaultColor: '#222222',
      align: 'middle',
    },
    ...overrides,
  };
}

describe('mapElementJsonPatchToEditIntents', () => {
  it('maps one guarded text content and style patch into one atomic intent batch', () => {
    const result = mapElementJsonPatchToEditIntents(
      [
        { op: 'test', path: '/elements/0/id', value: 'title' },
        { op: 'replace', path: '/elements/0/content', value: '<p>New title</p>' },
        { op: 'replace', path: '/elements/0/defaultColor', value: '#2563eb' },
      ],
      [textElement()],
    );

    expect(result).toEqual({
      ok: true,
      intents: [
        { type: 'element.update', id: 'title', props: { defaultColor: '#2563eb' } },
        {
          type: 'text.updateContent',
          id: 'title',
          content: '<p>New title</p>',
          target: 'text',
        },
      ],
      targetIds: ['title'],
    });
  });

  it('maps real shape.text paths to the existing flattened shape-text intent contract', () => {
    const result = mapElementJsonPatchToEditIntents(
      [
        { op: 'test', path: '/elements/0/id', value: 'shape-1' },
        { op: 'replace', path: '/elements/0/text/content', value: '<p>New label</p>' },
        { op: 'replace', path: '/elements/0/text/defaultColor', value: '#dc2626' },
        { op: 'replace', path: '/elements/0/text/align', value: 'bottom' },
      ],
      [shapeElement()],
    );

    expect(result).toEqual({
      ok: true,
      intents: [
        {
          type: 'element.update',
          id: 'shape-1',
          props: { defaultColor: '#dc2626', vAlign: 'bottom' },
        },
        {
          type: 'text.updateContent',
          id: 'shape-1',
          content: '<p>New label</p>',
          target: 'shape',
        },
      ],
      targetIds: ['shape-1'],
    });
  });

  it('enforces group cohesion for content-only and mixed content/style patches', () => {
    const grouped = [
      textElement({ id: 'group-a', groupId: 'group-1' }),
      textElement({ id: 'group-b', groupId: 'group-1', left: 600 }),
    ];

    const partial = mapElementJsonPatchToEditIntents(
      [
        { op: 'test', path: '/elements/0/id', value: 'group-a' },
        { op: 'replace', path: '/elements/0/content', value: '<p>Changed</p>' },
      ],
      grouped,
    );
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.reason).toMatch(/group.*missing.*group-b/i);

    expect(
      mapElementJsonPatchToEditIntents(
        [
          { op: 'test', path: '/elements/0/id', value: 'group-a' },
          { op: 'replace', path: '/elements/0/content', value: '<p>Changed</p>' },
          { op: 'test', path: '/elements/1/id', value: 'group-b' },
          { op: 'replace', path: '/elements/1/defaultColor', value: '#2563eb' },
        ],
        grouped,
      ),
    ).toMatchObject({ ok: true, targetIds: ['group-a', 'group-b'] });
  });

  it('supports nested replacement within an allowed structured style property', () => {
    const result = mapElementJsonPatchToEditIntents(
      [
        { op: 'test', path: '/elements/0/id', value: 'title' },
        { op: 'replace', path: '/elements/0/shadow/color', value: '#ff0000' },
      ],
      [
        textElement({
          shadow: { h: 1, v: 2, blur: 3, color: '#000000' },
        }),
      ],
    );

    expect(result).toMatchObject({
      ok: true,
      intents: [
        {
          type: 'element.update',
          id: 'title',
          props: { shadow: { color: '#ff0000' } },
        },
      ],
    });
  });

  it('patches one filter leaf without normalizing untouched legacy-unit siblings', () => {
    const image = {
      id: 'image-1',
      type: 'image',
      left: 10,
      top: 20,
      width: 300,
      height: 200,
      rotate: 0,
      fixedRatio: true,
      src: 'https://example.com/image.png',
      filters: { blur: '2px', contrast: '90%' },
    } as PPTElement;

    expect(
      mapElementJsonPatchToEditIntents(
        [
          { op: 'test', path: '/elements/0/id', value: 'image-1' },
          { op: 'add', path: '/elements/0/filters/brightness', value: '120' },
        ],
        [image],
      ),
    ).toEqual({
      ok: true,
      intents: [
        {
          type: 'element.update',
          id: 'image-1',
          props: { filters: { brightness: '120' } },
        },
      ],
      targetIds: ['image-1'],
    });
  });

  it('preserves siblings created by a whole structured add before a nested edit', () => {
    expect(
      mapElementJsonPatchToEditIntents(
        [
          { op: 'test', path: '/elements/0/id', value: 'title' },
          {
            op: 'add',
            path: '/elements/0/shadow',
            value: { h: 1, v: 2, blur: 3, color: '#000000' },
          },
          { op: 'replace', path: '/elements/0/shadow/blur', value: 4 },
        ],
        [textElement()],
      ),
    ).toEqual({
      ok: true,
      intents: [
        {
          type: 'element.update',
          id: 'title',
          props: { shadow: { h: 1, v: 2, blur: 4, color: '#000000' } },
        },
      ],
      targetIds: ['title'],
    });
  });

  it('marks a whole structured-property replace so omitted siblings are removed', () => {
    const image = {
      id: 'image-1',
      type: 'image',
      left: 10,
      top: 20,
      width: 300,
      height: 200,
      rotate: 0,
      fixedRatio: true,
      src: 'https://example.com/image.png',
      filters: { blur: '2', contrast: '90' },
      outline: { width: 1, style: 'solid', color: '#000000' },
      shadow: { h: 1, v: 2, blur: 3, color: '#000000' },
    } as PPTElement;

    expect(
      mapElementJsonPatchToEditIntents(
        [
          { op: 'test', path: '/elements/0/id', value: 'image-1' },
          { op: 'replace', path: '/elements/0/filters', value: { brightness: '120' } },
          {
            op: 'replace',
            path: '/elements/0/outline',
            value: { width: 2, color: '#ff0000' },
          },
          {
            op: 'replace',
            path: '/elements/0/shadow',
            value: { h: 4, v: 5, blur: 6, color: '#00ff00' },
          },
        ],
        [image],
      ),
    ).toEqual({
      ok: true,
      intents: [
        {
          type: 'element.removeProps',
          id: 'image-1',
          props: ['filters', 'outline', 'shadow'],
        },
        {
          type: 'element.update',
          id: 'image-1',
          props: {
            filters: { brightness: '120' },
            outline: { width: 2, color: '#ff0000' },
            shadow: { h: 4, v: 5, blur: 6, color: '#00ff00' },
          },
        },
      ],
      targetIds: ['image-1'],
    });
  });

  it('accepts identity replacements whose effect is clearing active structured styles', () => {
    const image = {
      id: 'image-1',
      type: 'image',
      left: 10,
      top: 20,
      width: 300,
      height: 200,
      rotate: 0,
      fixedRatio: true,
      src: 'https://example.com/image.png',
      filters: { blur: '2', contrast: '90' },
      outline: { width: 2, style: 'solid', color: '#ff0000' },
      shadow: { h: 1, v: 2, blur: 3, color: '#000000' },
    } as PPTElement;

    expect(
      mapElementJsonPatchToEditIntents(
        [
          { op: 'test', path: '/elements/0/id', value: 'image-1' },
          { op: 'replace', path: '/elements/0/filters', value: { brightness: '100' } },
          { op: 'replace', path: '/elements/0/outline', value: { width: 0 } },
          {
            op: 'replace',
            path: '/elements/0/shadow',
            value: { h: 0, v: 0, blur: 0, color: 'transparent' },
          },
        ],
        [image],
      ),
    ).toEqual({
      ok: true,
      intents: [
        {
          type: 'element.removeProps',
          id: 'image-1',
          props: ['filters', 'outline', 'shadow'],
        },
        {
          type: 'element.update',
          id: 'image-1',
          props: {
            filters: { brightness: '100' },
            outline: { width: 0 },
            shadow: { h: 0, v: 0, blur: 0, color: 'transparent' },
          },
        },
      ],
      targetIds: ['image-1'],
    });
  });

  it('adds an absent optional style without allowing element insertion', () => {
    const result = mapElementJsonPatchToEditIntents(
      [
        { op: 'test', path: '/elements/0/id', value: 'title' },
        { op: 'add', path: '/elements/0/opacity', value: 0.5 },
        {
          op: 'add',
          path: '/elements/0/shadow',
          value: { h: 1, v: 2, blur: 3, color: '#000000' },
        },
      ],
      [textElement()],
    );

    expect(result).toMatchObject({
      ok: true,
      intents: [
        {
          type: 'element.update',
          id: 'title',
          props: {
            opacity: 0.5,
            shadow: { h: 1, v: 2, blur: 3, color: '#000000' },
          },
        },
      ],
    });

    expect(
      mapElementJsonPatchToEditIntents(
        [
          { op: 'test', path: '/elements/0/id', value: 'title' },
          { op: 'add', path: '/elements/-', value: textElement({ id: 'new' }) },
        ],
        [textElement()],
      ),
    ).toEqual({ ok: false, reason: 'path /elements/- does not target an existing element' });

    expect(
      mapElementJsonPatchToEditIntents(
        [
          { op: 'test', path: '/elements/0/id', value: 'title' },
          { op: 'add', path: '/elements/0/width', value: 300 },
        ],
        [textElement()],
      ),
    ).toEqual({
      ok: false,
      reason: '/elements/0/width: add only supports an absent optional property',
    });
  });

  it('requires an id test before each indexed element replacement', () => {
    expect(
      mapElementJsonPatchToEditIntents(
        [{ op: 'replace', path: '/elements/0/defaultColor', value: '#2563eb' }],
        [textElement()],
      ),
    ).toEqual({
      ok: false,
      reason: 'element index 0 must be guarded by a preceding id test',
    });
  });

  it('refuses a stale or mis-indexed id test', () => {
    expect(
      mapElementJsonPatchToEditIntents(
        [
          { op: 'test', path: '/elements/0/id', value: 'not-title' },
          { op: 'replace', path: '/elements/0/defaultColor', value: '#2563eb' },
        ],
        [textElement()],
      ),
    ).toEqual({
      ok: false,
      reason: 'test failed at /elements/0/id',
    });
  });

  it('refuses unsupported operations and paths', () => {
    expect(
      mapElementJsonPatchToEditIntents(
        [
          { op: 'test', path: '/elements/0/id', value: 'title' },
          { op: 'remove', path: '/elements/0' },
        ],
        [textElement()],
      ),
    ).toEqual({ ok: false, reason: 'operation 1 uses unsupported op "remove"' });

    expect(
      mapElementJsonPatchToEditIntents(
        [
          { op: 'test', path: '/elements/0/id', value: 'title' },
          { op: 'replace', path: '/elements/0/id', value: 'renamed' },
        ],
        [textElement()],
      ),
    ).toEqual({ ok: false, reason: 'path /elements/0/id is not editable' });
  });

  it('refuses locked elements before producing any intents', () => {
    expect(
      mapElementJsonPatchToEditIntents(
        [
          { op: 'test', path: '/elements/0/id', value: 'title' },
          { op: 'replace', path: '/elements/0/defaultColor', value: '#2563eb' },
        ],
        [textElement({ lock: true })],
      ),
    ).toEqual({ ok: false, reason: 'element "title" is locked' });
  });

  it('validates the final element schema and refuses the whole batch', () => {
    const elements: PPTElement[] = [textElement()];
    const result = mapElementJsonPatchToEditIntents(
      [
        { op: 'test', path: '/elements/0/id', value: 'title' },
        { op: 'replace', path: '/elements/0/defaultColor', value: '#2563eb' },
        { op: 'replace', path: '/elements/0/content', value: 42 },
      ],
      elements,
    );

    expect(result).toEqual({ ok: false, reason: 'text content must be a string' });
    expect(elements[0]).toEqual(textElement());
  });

  it.each([
    '<img src=x onerror="alert(1)">',
    '<script>alert(1)</script><p>Safe</p>',
    '<svg><a href="javascript:alert(1)">x</a></svg>',
    '<p style="background-image:url(javascript:alert(1))">x</p>',
    '<p style="background: \\75rl(https://attacker.example/pixel)">x</p>',
    '<div style="position:fixed;left:0;top:0;width:100vw;height:100vh">x</div>',
  ])('refuses unsafe rich text HTML: %s', (content) => {
    const result = mapElementJsonPatchToEditIntents(
      [
        { op: 'test', path: '/elements/0/id', value: 'title' },
        { op: 'replace', path: '/elements/0/content', value: content },
      ],
      [textElement()],
    );
    expect(result).toEqual({ ok: false, reason: 'text content contains unsafe HTML' });
  });

  it.each([
    '<p style="text-align: center">New title</p>',
    '<span style="color: #ff0000">New title&nbsp;</span>',
    '<p>New title<br class="ProseMirror-trailingBreak"></p>',
    '<ol start="2"><li value="3"><span data-mark="kept">New title</span></li></ol>',
    '<p data-indent="2"><mark data-index="1"><span style="text-decoration-line: line-through;">New title</span></mark></p>',
    '<div data-pptx-text-warp="archUp" style="position: relative;width: 100%;height: 42px;white-space: nowrap;"><span style="position: absolute;left: 10%;top: 20%;font-size: 24pt;line-height: 1;transform: translate(-50%, -50%) rotate(12deg);transform-origin: center center;white-space: nowrap;">New title</span></div>',
    '<p style="margin-left: 30px;text-indent: -30px;padding-top: 2pt;"><span style="display:inline-block;width:30px;text-indent:0;padding-left:16px;padding-right:0.4em;box-sizing:border-box;">•</span>New title</p>',
  ])('accepts safe editor HTML despite sanitizer canonicalization: %s', (content) => {
    const result = mapElementJsonPatchToEditIntents(
      [
        { op: 'test', path: '/elements/0/id', value: 'title' },
        { op: 'replace', path: '/elements/0/content', value: content },
      ],
      [textElement()],
    );
    expect(result).toMatchObject({
      ok: true,
      intents: [{ type: 'text.updateContent', id: 'title', content, target: 'text' }],
    });
  });

  it('refuses a slide with duplicate ids before indexed patches can collapse by id', () => {
    const result = mapElementJsonPatchToEditIntents(
      [
        { op: 'test', path: '/elements/0/id', value: 'title' },
        { op: 'replace', path: '/elements/0/top', value: 10 },
        { op: 'test', path: '/elements/1/id', value: 'title' },
        { op: 'replace', path: '/elements/1/top', value: 30 },
      ],
      [textElement(), textElement({ top: 20 })],
    );
    expect(result).toEqual({
      ok: false,
      reason: 'slide contains duplicate element id "title"',
    });
  });

  it('refuses direct replacement of text too large to expose exactly', () => {
    const result = mapElementJsonPatchToEditIntents(
      [
        { op: 'test', path: '/elements/0/id', value: 'title' },
        { op: 'replace', path: '/elements/0/content', value: '<p>Short replacement</p>' },
      ],
      [textElement({ content: `<p>${'x'.repeat(30001)}</p>` })],
    );
    expect(result).toEqual({
      ok: false,
      reason: 'text content is too large for exact JSON Patch replacement',
    });
  });

  it.each([
    {
      element: textElement(),
      path: '/elements/0/content',
      value: `<p>${'x'.repeat(30001)}</p>`,
      reason: 'new text content is too large for exact JSON Patch replacement',
    },
    {
      element: shapeElement(),
      path: '/elements/0/text/content',
      value: `<p>${'\u0000'.repeat(10001)}</p>`,
      reason: 'new shape text content is too large for exact JSON Patch replacement',
    },
  ])('refuses an oversized new content value at $path', ({ element, path, value, reason }) => {
    const result = mapElementJsonPatchToEditIntents(
      [
        { op: 'test', path: '/elements/0/id', value: element.id },
        { op: 'replace', path, value },
      ],
      [element],
    );
    expect(result).toEqual({ ok: false, reason });
  });

  it('refuses values that the legacy intent layer would silently normalize', () => {
    const result = mapElementJsonPatchToEditIntents(
      [
        { op: 'test', path: '/elements/0/id', value: 'title' },
        { op: 'replace', path: '/elements/0/width', value: 1 },
        { op: 'replace', path: '/elements/0/rotate', value: 360 },
      ],
      [textElement()],
    );
    expect(result).toEqual({
      ok: false,
      reason:
        'patch values for element "title" would be normalized; submit canonical values already within renderer bounds and units',
    });
  });

  it('refuses empty and no-op batches', () => {
    expect(mapElementJsonPatchToEditIntents([], [textElement()])).toEqual({
      ok: false,
      reason: 'no JSON Patch operations proposed',
    });
    expect(
      mapElementJsonPatchToEditIntents(
        [
          { op: 'test', path: '/elements/0/id', value: 'title' },
          { op: 'replace', path: '/elements/0/defaultColor', value: '#111111' },
        ],
        [textElement()],
      ),
    ).toEqual({ ok: false, reason: 'patch does not change any element' });
  });
});
