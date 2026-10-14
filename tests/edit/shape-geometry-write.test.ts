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
