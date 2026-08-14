import type { InsertToolbarItem } from '../types';

export const DEFAULT_EDITOR_INSERT_ITEMS = [
  'text',
  'image',
  'table',
  'chart',
  'line',
  'background',
  'latex',
  'video',
  'audio',
] as const;

export type EditorInsertItem = (typeof DEFAULT_EDITOR_INSERT_ITEMS)[number];

export interface EditorInsertContribution {
  readonly type: EditorInsertItem;
  readonly item: InsertToolbarItem;
}

export function resolveEditorInsertItems(
  contributions: readonly EditorInsertContribution[],
  order: readonly EditorInsertItem[] = DEFAULT_EDITOR_INSERT_ITEMS,
): readonly InsertToolbarItem[] {
  const byType = new Map(contributions.map(({ type, item }) => [type, item]));
  const seen = new Set<EditorInsertItem>();

  return order.flatMap((type) => {
    if (seen.has(type)) return [];
    seen.add(type);
    const item = byType.get(type);
    return item ? [item] : [];
  });
}
