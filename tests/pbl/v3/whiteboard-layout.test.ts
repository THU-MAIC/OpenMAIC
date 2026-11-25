import { expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { whiteboardElementExtent, whiteboardLayoutWarnings } from '@/lib/pbl/v3/whiteboard-tools';

const canvas = { width: 1000, height: 562.5 };
const text = (id: string, content: string, box: Partial<PPTElement> = {}) =>
  ({
    id,
    type: 'text',
    left: 32,
    top: 32,
    width: 400,
    height: 50,
    rotate: 0,
    content: `<p style="font-size: 20px;">${content}</p>`,
    defaultFontName: 'x',
    defaultColor: '#333',
    ...box,
  }) as PPTElement;
const box = (id: string, at: Partial<PPTElement>) =>
  ({ id, type: 'shape', left: 0, top: 0, width: 100, height: 60, rotate: 0, ...at }) as PPTElement;

it('measures text by what it draws, not by the height it was given', () => {
  // 40 full-width characters at size 20 in 380 of room wrap onto three lines.
  expect(whiteboardElementExtent(text('a', '字'.repeat(40))).height).toBe(20 + 3 * 30);
  expect(whiteboardElementExtent(text('a', '一行')).height).toBe(50);
});

it('tells the role when a change left the canvas or landed on another block', () => {
  expect(whiteboardLayoutWarnings(text('a', '一行'), [], canvas)).toEqual([]);
  const low = whiteboardLayoutWarnings(text('a', '一行', { top: 540 }), [], canvas);
  expect(low[0]).toContain('below the bottom of the canvas');
  expect(low.at(-1)).toContain('Delete or move');
  const wrapped = whiteboardLayoutWarnings(text('a', '字'.repeat(40)), [], canvas);
  expect(wrapped[0]).toContain('needs about 110 of height');
  const over = whiteboardLayoutWarnings(
    text('b', '另一行', { top: 50 }),
    [text('a', '一行'), text('b', '另一行', { top: 50 })],
    canvas,
  );
  expect(over[0]).toContain('overlaps element a');
});

it('lets a label sit on its box', () => {
  expect(
    whiteboardLayoutWarnings(
      text('label', '页面', { left: 100, top: 105, width: 160, height: 50 }),
      [box('rect', { left: 100, top: 100, width: 160, height: 60 })],
      canvas,
    ),
  ).toEqual([]);
});
