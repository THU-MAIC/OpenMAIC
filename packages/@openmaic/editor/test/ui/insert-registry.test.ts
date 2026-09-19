import { describe, expect, it } from 'vitest';
import type { InsertToolbarItem } from '../../src/ui/types';
import {
  DEFAULT_EDITOR_INSERT_ITEMS,
  resolveEditorInsertItems,
  type EditorInsertContribution,
} from '../../src/ui/adapters/insertRegistry';

function contribution(type: EditorInsertContribution['type']): EditorInsertContribution {
  const item: InsertToolbarItem = {
    id: `insert-${type}`,
    label: type,
    icon: null,
  };
  return { type, item };
}

const available = DEFAULT_EDITOR_INSERT_ITEMS.map(contribution);

describe('editor insert registry', () => {
  it('uses the current toolbar order when no order is supplied', () => {
    expect(resolveEditorInsertItems(available).map((item) => item.label)).toEqual([
      'text',
      'image',
      'table',
      'chart',
      'line',
      'background',
      'latex',
      'video',
      'audio',
    ]);
  });

  it('filters and orders insert buttons from the configured string array', () => {
    expect(
      resolveEditorInsertItems(available, ['audio', 'text', 'image']).map((item) => item.label),
    ).toEqual(['audio', 'text', 'image']);
  });

  it('shows no insert buttons for an empty array and ignores duplicate entries', () => {
    expect(resolveEditorInsertItems(available, [])).toEqual([]);
    expect(
      resolveEditorInsertItems(available, ['image', 'image', 'text']).map((item) => item.label),
    ).toEqual(['image', 'text']);
  });
});
