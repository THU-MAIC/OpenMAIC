import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildInsertItems,
  deleteSlideElement,
  insertChartElement,
  insertTableElement,
} from '@/components/edit/surfaces/slide/use-slide-surface';
import { useSlideEditSession } from '@/components/edit/surfaces/slide/slide-edit-session';
import { createDefaultLatexElement } from '@/lib/edit/slide-edit-elements';
import { useCanvasStore } from '@/lib/store/canvas';

function seedSlideSession(elements: unknown[] = []) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  useSlideEditSession.setState({
    history: {
      past: [],
      present: { type: 'slide', canvas: { id: 's', elements } } as any,
      future: [],
    },
  } as any);
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

describe('slide insert palette', () => {
  beforeEach(() => seedSlideSession());
  afterEach(() => vi.restoreAllMocks());

  it('exposes only legacy-supported text-box and image insert items', () => {
    const items = buildInsertItems((k) => k, undefined);
    expect(items.map((i) => i.id)).toEqual(['insert-text', 'insert-image', 'slide-background']);
    expect(items[1].popoverContent).toBeTypeOf('function');
    expect(items[0].onInvoke).toBeTypeOf('function');
  });

  it('text-box invoke arms text-insertion (sets creatingElement)', () => {
    const spy = vi.spyOn(useCanvasStore.getState(), 'setCreatingElement');
    buildInsertItems((k) => k, undefined)[0].onInvoke();
    expect(spy).toHaveBeenCalledWith({ type: 'text' });
  });

  it('text-box invoke when already armed disarms (sets creatingElement to null)', () => {
    const spy = vi.spyOn(useCanvasStore.getState(), 'setCreatingElement');
    buildInsertItems((k) => k, 'text')[0].onInvoke();
    expect(spy).toHaveBeenCalledWith(null);
  });

  it('text-box reports active when creating-text is armed', () => {
    expect(buildInsertItems((k) => k, 'text')[0].active).toBe(true);
    expect(buildInsertItems((k) => k, undefined)[0].active).toBe(false);
  });

  it('keeps renderer-only line insertion out of the legacy app palette', () => {
    const items = buildInsertItems((k) => k, undefined);

    expect(items.find((item) => item.id === 'insert-line')).toBeUndefined();
  });

  it('inserts and selects the requested empty table through the slide session', () => {
    const operationSpy = vi.spyOn(useSlideEditSession.getState(), 'applyOp');
    const selectionSpy = vi.spyOn(useCanvasStore.getState(), 'setActiveElementIdList');

    insertTableElement(3, 4);

    expect(operationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'element.add',
        element: expect.objectContaining({
          type: 'table',
          cellMinHeight: 36,
          colWidths: [0.25, 0.25, 0.25, 0.25],
          data: expect.arrayContaining([expect.any(Array)]),
        }),
      }),
    );
    const operation = operationSpy.mock.calls[0][0];
    if (operation.type !== 'element.add') throw new Error('Expected an element.add operation');
    const { element } = operation;
    if (element.type !== 'table') throw new Error('Expected an inserted table');
    expect(element.data).toHaveLength(3);
    expect(element.data.flat()).toHaveLength(12);
    expect(selectionSpy).toHaveBeenCalledWith([element.id]);
  });

  it('inserts and selects a default chart through the slide session', () => {
    const operationSpy = vi.spyOn(useSlideEditSession.getState(), 'applyOp');
    const selectionSpy = vi.spyOn(useCanvasStore.getState(), 'setActiveElementIdList');

    insertChartElement('line');

    const operation = operationSpy.mock.calls.at(-1)?.[0];
    if (!operation || operation.type !== 'element.add') {
      throw new Error('Expected an element.add operation');
    }
    expect(operation.element).toMatchObject({
      type: 'chart',
      chartType: 'line',
      data: { labels: ['A', 'B', 'C', 'D'], legends: ['Series 1'] },
    });
    expect(selectionSpy).toHaveBeenCalledWith([operation.element.id]);
  });

  it('creates a renderer Latex element with the shared editor result', () => {
    expect(
      createDefaultLatexElement('formula-1', {
        latex: '\\frac{a}{b}',
        html: '<span class="katex">a/b</span>',
        width: 160,
        height: 60,
      }),
    ).toEqual({
      id: 'formula-1',
      type: 'latex',
      left: 160,
      top: 160,
      width: 160,
      height: 60,
      rotate: 0,
      latex: '\\frac{a}{b}',
      html: '<span class="katex">a/b</span>',
      color: '#333333',
      align: 'center',
      fixedRatio: true,
    });
  });
});

describe('slide element deletion', () => {
  afterEach(() => vi.restoreAllMocks());

  it('deleteSlideElement deletes an existing element through the canonical operation', () => {
    seedSlideSession([{ id: 'img-9', type: 'image', src: 'image.png' }]);
    const spy = vi.spyOn(useSlideEditSession.getState(), 'applyOp');

    deleteSlideElement('img-9');

    expect(spy).toHaveBeenCalledWith({ type: 'element.delete', elementId: 'img-9' });
    expect(useSlideEditSession.getState().history?.present.canvas.elements).toEqual([]);
  });
});
