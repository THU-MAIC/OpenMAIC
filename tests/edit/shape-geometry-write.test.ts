import { describe, expect, it } from 'vitest';
import { createDefaultShapeElement } from '@/lib/edit/slide-edit-elements';
import {
  validateElementInput,
  validateSlideCanvas,
} from '@/lib/server/agent-runtime/course-edit/element-schema';
import { applySlideEdit } from '@/lib/server/agent-runtime/course-edit/apply';
import { applySlideEditOperation, createSlideEditHistory } from '@/lib/edit/slide-ops';
import type { SlideContent } from '@openmaic/dsl';

function content(): SlideContent {
  return {
    type: 'slide',
    canvas: {
      id: 'slide',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        fontName: 'Arial',
        fontColor: '#000',
        backgroundColor: '#fff',
        themeColors: ['#000'],
      },
      elements: [createDefaultShapeElement('shape')],
    },
  };
}

describe('agent shape write validation', () => {
  it.each(['path', 'viewBox', 'width', 'height'])(
    'rejects removing required shape geometry: %s',
    (field) => {
      const history = createSlideEditHistory(content());
      expect(() =>
        applySlideEditOperation(history, {
          type: 'element.removeProps',
          elementId: 'shape',
          propNames: [field],
        }),
      ).toThrow();
      expect(history.past).toEqual([]);
      expect(history.present).toEqual(content());
    },
  );

  it('permits removing unrelated style properties from historical bad shapes', () => {
    const slide = content();
    const shape = slide.canvas.elements[0];
    if (shape.type !== 'shape') throw new Error('expected shape');
    shape.path = 'M0 0 Z1 1';
    const next = applySlideEditOperation(slide, {
      type: 'element.removeProps',
      elementId: 'shape',
      propNames: ['fill'],
    });
    expect(next.canvas.elements[0]).not.toHaveProperty('fill');
  });
  it.each(['width', 'height', 'viewBox[0]', 'viewBox[1]'])(
    'permits a style edit when historical %s is NaN',
    (field) => {
      const slide = content();
      const shape = slide.canvas.elements[0];
      if (shape.type !== 'shape') throw new Error('expected shape');
      if (field === 'width' || field === 'height') shape[field] = NaN;
      else shape.viewBox[field === 'viewBox[0]' ? 0 : 1] = NaN;
      const next = applySlideEditOperation(slide, {
        type: 'element.update',
        elementId: 'shape',
        patch: { fill: '#123456' },
      });
      expect(next.canvas.elements[0]).toMatchObject({ fill: '#123456' });
      expect(validateSlideCanvas(next.canvas, slide.canvas)).toEqual([]);
      expect(
        applySlideEdit(slide, {
          op: 'patch',
          action: 'set',
          path: '/canvas/elements/0/fill',
          value: '#123456',
        }),
      ).toMatchObject({ ok: true });
    },
  );
  it('rejects changing an extra viewBox entry on a historical shape', () => {
    const slide = content();
    const shape = slide.canvas.elements[0];
    if (shape.type !== 'shape') throw new Error('expected shape');
    shape.viewBox = [100, 100, 1] as unknown as [number, number];
    expect(() =>
      applySlideEditOperation(slide, {
        type: 'element.update',
        elementId: 'shape',
        patch: { viewBox: [100, 100, 2] as unknown as [number, number] },
      }),
    ).toThrow(/viewBox/);
    expect(shape.viewBox).toEqual([100, 100, 1]);
  });

  it.each([
    { field: 'viewBox', value: '100 100' },
    { field: 'viewBox', value: [100, 100, 1] },
    { field: 'viewBox', value: [100] },
    { field: 'viewBox', value: [] },
    { field: 'viewBox', value: [100, '100'] },
    { field: 'viewBox', value: null },
    { field: 'viewBox', value: undefined },
    { field: 'width', value: '100' },
    { field: 'width', value: null },
    { field: 'width', value: undefined },
    { field: 'height', value: false },
    { field: 'height', value: '100' },
    { field: 'path', value: 123 },
    { field: 'path', value: null },
    { field: 'path', value: undefined },
  ])('permits style edits without rewriting historical $field=$value', ({ field, value }) => {
    const slide = content();
    const shape = slide.canvas.elements[0];
    if (value === undefined) Reflect.deleteProperty(shape, field);
    else Reflect.set(shape, field, value);
    const before = structuredClone(slide);

    const patched = applySlideEdit(slide, {
      op: 'patch',
      action: 'set',
      path: '/canvas/elements/0/fill',
      value: '#123456',
    });
    expect(patched).toMatchObject({ ok: true });
    if (!patched.ok) throw new Error(patched.error);
    expect(patched.value.canvas.elements[0]).toEqual({
      ...before.canvas.elements[0],
      fill: '#123456',
    });
    expect(slide).toEqual(before);
    expect(validateSlideCanvas(patched.value.canvas, slide.canvas)).toEqual([]);
    expect(validateSlideCanvas(patched.value.canvas).length).toBeGreaterThan(0);
    const input = { ...shape };
    Reflect.deleteProperty(input, 'id');
    expect(validateElementInput(input).length).toBeGreaterThan(0);
  });

  it('keeps geometry writes and non-geometry schema validation strict for historical shapes', () => {
    const slide = content();
    Reflect.set(slide.canvas.elements[0], 'viewBox', [100, 100, 1]);
    for (const [path, value] of [
      ['/canvas/elements/0/viewBox/2', 2],
      ['/canvas/elements/0/width', 200],
      ['/canvas/elements/0/fill', 123],
      ['/canvas/elements/0/unknown', 'value'],
    ] as const) {
      expect(applySlideEdit(slide, { op: 'patch', action: 'set', path, value })).toMatchObject({
        ok: false,
      });
    }
  });
  it.each(['M0 0 Z1 1', 'M0 0 L1e999 0', '<svg/>'])(
    'rejects an invalid complete new path: %s',
    (path) => {
      const shape = { ...createDefaultShapeElement('shape'), path };
      Reflect.deleteProperty(shape, 'id');
      expect(validateElementInput(shape)).toEqual([expect.stringMatching(/element\/path/)]);
    },
  );

  it('rejects a JSON pointer geometry patch without changing the original', () => {
    const slide = content();
    const before = structuredClone(slide);
    expect(
      applySlideEdit(slide, {
        op: 'patch',
        action: 'set',
        path: '/canvas/elements/0/path',
        value: 'M0 0 Z1 1',
      }),
    ).toMatchObject({ ok: false });
    expect(
      applySlideEdit(slide, {
        op: 'patch',
        action: 'set',
        path: '/canvas/elements/0/viewBox/0',
        value: 0,
      }),
    ).toMatchObject({ ok: false });
    expect(slide).toEqual(before);
  });

  it('allows unrelated patches to historical bad and complex geometry', () => {
    for (const path of ['M0 0 Z1 1', 'M0 0' + ' L1 1'.repeat(10_001)]) {
      const slide = content();
      const shape = slide.canvas.elements[0];
      if (shape.type !== 'shape') throw new Error('expected shape');
      shape.path = path;
      const patched = applySlideEdit(slide, {
        op: 'patch',
        action: 'set',
        path: '/canvas/elements/0/fill',
        value: '#123456',
      });
      expect(patched).toMatchObject({ ok: true });
      expect(validateSlideCanvas(slide.canvas, slide.canvas)).toEqual([]);
    }
  });
});
