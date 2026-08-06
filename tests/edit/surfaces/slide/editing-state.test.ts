import { describe, expect, test } from 'vitest';
import {
  resolveEditingElementId,
  resolveSelectedElement,
} from '@/components/edit/surfaces/slide/editing-state';
import {
  createDefaultImageElement,
  createDefaultShapeElement,
  createDefaultTextElement,
} from '@/lib/edit/slide-edit-elements';

const text = createDefaultTextElement('t1');
const image = createDefaultImageElement('i1', 'gen_img_x');
const shape = createDefaultShapeElement('s1');

describe('resolveSelectedElement', () => {
  test('returns undefined when nothing is selected', () => {
    expect(resolveSelectedElement([], [text])).toBeUndefined();
  });

  test('returns undefined for a multi-selection', () => {
    expect(resolveSelectedElement(['t1', 'i1'], [text, image])).toBeUndefined();
  });

  test('returns undefined when the selected id is not found', () => {
    expect(resolveSelectedElement(['ghost'], [text])).toBeUndefined();
  });

  test('returns the element for a single selection', () => {
    expect(resolveSelectedElement(['i1'], [text, image])).toBe(image);
  });
});

describe('resolveEditingElementId', () => {
  test('returns "" when nothing is selected', () => {
    expect(resolveEditingElementId([], [text])).toBe('');
  });

  test('returns "" for a multi-selection', () => {
    expect(resolveEditingElementId(['t1', 'i1'], [text, image])).toBe('');
  });

  test('returns "" when the single selection is not a text element', () => {
    expect(resolveEditingElementId(['i1'], [text, image])).toBe('');
  });

  test('returns "" when the selected id is not found', () => {
    expect(resolveEditingElementId(['ghost'], [text])).toBe('');
  });

  test('returns the id when a single text element is selected', () => {
    expect(resolveEditingElementId(['t1'], [text, image])).toBe('t1');
  });

  test('requires the explicit renderer editing id to match the selected text', () => {
    expect(resolveEditingElementId(['t1'], [text, image], '')).toBe('');
    expect(resolveEditingElementId(['t1'], [text, image], 't1')).toBe('t1');
    expect(resolveEditingElementId(['t1'], [text, image], 'other')).toBe('');
  });

  test('rejects a locked text in explicit renderer mode', () => {
    expect(resolveEditingElementId(['t1'], [{ ...text, lock: true }], 't1')).toBe('');
  });

  test('allows renderer mode to explicitly edit a selected Shape label', () => {
    expect(resolveEditingElementId(['s1'], [text, shape], 's1', ['text', 'shape'])).toBe('s1');
  });
});
