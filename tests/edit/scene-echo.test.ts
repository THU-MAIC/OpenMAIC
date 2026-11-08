import { describe, expect, it } from 'vitest';
import { keepLocalWhereUnchanged } from '@/lib/edit/scene-echo';
import { mergeFetchedScenes } from '@/lib/workbench/stage-freshness';
import type { Scene, SlideContent } from '@/lib/types/stage';

function quiz(
  id: string,
  questions: unknown[] = [],
  overrides: Record<string, unknown> = {},
): Scene {
  return {
    id,
    stageId: 's',
    type: 'quiz',
    title: id,
    order: 1,
    content: { type: 'quiz', questions },
    actions: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as unknown as Scene;
}

function slideWithHtml(id: string, html: string): Scene {
  return {
    id,
    stageId: 's',
    type: 'slide',
    title: id,
    order: 1,
    content: {
      type: 'slide',
      schemaVersion: 1,
      canvas: {
        id: 'c',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {},
        elements: [
          {
            id: 't',
            type: 'text',
            left: 0,
            top: 0,
            width: 100,
            height: 50,
            rotate: 0,
            content: html,
          },
        ],
      },
    },
    actions: [],
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Scene;
}

describe('keepLocalWhereUnchanged', () => {
  it('keeps the object for a copy equal to what is shown', () => {
    const local = quiz('a', [{ id: 'q' }]);
    const [result] = keepLocalWhereUnchanged([local], [JSON.parse(JSON.stringify(local))]);
    expect(result).toBe(local);
  });

  it('sees a save read back through the sanitizer as unchanged', () => {
    const local = slideWithHtml('a', '<p style="">Hello</p>');
    const server = slideWithHtml('a', '<p>Hello</p>');
    const [result] = keepLocalWhereUnchanged([local], [server]);
    expect(result).toBe(local);
  });

  it('sees members in another order and dropped undefineds as unchanged', () => {
    const local = quiz('a', [{ id: 'q', note: undefined, text: 'x' }]);
    const server = quiz('a', [{ text: 'x', id: 'q' }]);
    expect(keepLocalWhereUnchanged([local], [server])[0]).toBe(local);
  });

  it('does not take a text height this browser measured for a change', () => {
    const measured = slideWithHtml('a', '<p>Hello</p>');
    const canvas = (measured.content as SlideContent).canvas;
    (canvas.elements[0] as unknown as { height: number }).height = 123;
    const server = slideWithHtml('a', '<p>Hello</p>');
    expect(keepLocalWhereUnchanged([measured], [server])[0]).toBe(measured);
  });

  it('takes a width another writer set on horizontal text', () => {
    const local = slideWithHtml('a', '<p>Hello</p>');
    const server = slideWithHtml('a', '<p>Hello</p>');
    const element = (server.content as SlideContent).canvas.elements[0] as unknown as {
      width: number;
    };
    element.width = 777;
    const [result] = keepLocalWhereUnchanged([local], [server]);
    expect(result).not.toBe(local);
    expect((result.content as SlideContent).canvas.elements[0].width).toBe(777);
  });

  it('on vertical text, ignores the measured width and takes a set height', () => {
    const vertical = (patch: Record<string, unknown>) => {
      const scene = slideWithHtml('a', '<p>Hello</p>');
      Object.assign((scene.content as SlideContent).canvas.elements[0], { vertical: true }, patch);
      return scene;
    };
    const local = vertical({});
    expect(keepLocalWhereUnchanged([local], [vertical({ width: 321 })])[0]).toBe(local);
    expect(keepLocalWhereUnchanged([local], [vertical({ height: 321 })])[0]).not.toBe(local);
  });

  it('takes a changed field and keeps the unchanged ones local', () => {
    const local = slideWithHtml('a', '<p style="">Hello</p>');
    const server = { ...slideWithHtml('a', '<p>Hello</p>'), title: 'Agent title' } as Scene;
    const [result] = keepLocalWhereUnchanged([local], [server]);
    expect(result.title).toBe('Agent title');
    expect(result.content).toBe(local.content);
  });

  it('takes the server order without treating it as a content change', () => {
    const local = quiz('a');
    const [result] = keepLocalWhereUnchanged([local], [{ ...local, order: 5 } as Scene]);
    expect(result.order).toBe(5);
    expect(result.content).toBe(local.content);
  });

  it('passes a page new to this browser through', () => {
    const added = quiz('n');
    expect(keepLocalWhereUnchanged([], [added])[0].id).toBe('n');
  });

  it('merges to no change for a pure echo', () => {
    const local = quiz('a');
    const merged = mergeFetchedScenes({
      current: [local],
      fetched: keepLocalWhereUnchanged([local], [JSON.parse(JSON.stringify(local))]),
      removedIds: [],
    });
    expect(merged.changed).toBe(false);
  });
});
