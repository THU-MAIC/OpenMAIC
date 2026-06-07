import { describe, expect, test } from 'vitest';
import {
  createDefaultImageElement,
  createDefaultShapeElement,
  createDefaultTextElement,
  htmlToPlainText,
  plainTextToParagraphHtml,
} from '@/lib/edit/slide-edit-elements';

describe('slide edit element factories', () => {
  test('creates default text elements compatible with the slide schema', () => {
    const element = createDefaultTextElement('text-1');

    expect(element).toMatchObject({
      id: 'text-1',
      type: 'text',
      content: '<p>New text</p>',
      defaultFontName: 'Inter',
      defaultColor: '#111827',
      lineHeight: 1.4,
    });
  });

  test('creates default shape elements with editable fill and outline', () => {
    const element = createDefaultShapeElement('shape-1');

    expect(element).toMatchObject({
      id: 'shape-1',
      type: 'shape',
      fill: '#dbeafe',
      outline: {
        width: 2,
        color: '#2563eb',
        style: 'solid',
      },
    });
    expect(element.viewBox).toEqual([260, 140]);
  });

  test('creates shape elements from a picked spec, preserving viewBox + path', () => {
    const element = createDefaultShapeElement('shape-2', {
      viewBox: [200, 200],
      path: 'M 100 0 L 200 200 L 0 200 Z',
    });

    expect(element).toMatchObject({
      id: 'shape-2',
      type: 'shape',
      viewBox: [200, 200],
      path: 'M 100 0 L 200 200 L 0 200 Z',
    });
    expect(element.width).toBe(200);
    expect(element.height).toBe(200);
  });

  test('creates default image elements from a source URL', () => {
    const element = createDefaultImageElement('image-1', 'https://example.com/image.png');

    expect(element).toMatchObject({
      id: 'image-1',
      type: 'image',
      src: 'https://example.com/image.png',
      fixedRatio: true,
      width: 360,
      height: 220,
    });
  });

  test('converts plain text to escaped paragraph html', () => {
    expect(plainTextToParagraphHtml('A < B & C')).toBe('<p>A &lt; B &amp; C</p>');
  });

  test('converts stored html content into editable plain text', () => {
    expect(htmlToPlainText('<p>Hello</p><p>World</p>')).toBe('HelloWorld');
  });
});
