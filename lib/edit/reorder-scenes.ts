import type { Scene } from '@/lib/types/stage';

/**
 * Swap a scene with its previous (`'up'`) or next (`'down'`) sibling and
 * preserve the original `order` values at each *position*. This is the
 * subtle part: scenes can carry non-contiguous order values (e.g. 1, 2, 4)
 * after deletions or insertions; if we kept each scene's own `order` after
 * swapping, the persisted array would render in the wrong sequence on next
 * load. Re-assigning by position keeps display-order == array-order.
 *
 * Returns the new array, or `null` when the move is a no-op (target out of
 * range, or sceneId not found).
 */
export function reorderScene(
  scenes: readonly Scene[],
  sceneId: string,
  direction: 'up' | 'down',
): Scene[] | null {
  const idx = scenes.findIndex((s) => s.id === sceneId);
  if (idx < 0) return null;
  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= scenes.length) return null;

  const swapped = scenes.slice();
  [swapped[idx], swapped[targetIdx]] = [swapped[targetIdx], swapped[idx]];

  const positionalOrders = scenes.map((s) => s.order);
  return swapped.map((s, i) => ({ ...s, order: positionalOrders[i] }));
}
