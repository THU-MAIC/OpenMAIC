import type { PPTElement } from '@openmaic/dsl';

/**
 * The single selected slide element — `undefined` unless exactly one element is
 * selected and it resolves in the content. The basis for the surface's
 * selection-anchored chrome (the text format bar, the image action bar).
 */
export function resolveSelectedElement(
  activeElementIdList: readonly string[],
  elements: readonly PPTElement[],
): PPTElement | undefined {
  if (activeElementIdList.length !== 1) return undefined;
  return elements.find((el) => el.id === activeElementIdList[0]);
}

/**
 * The slide surface's text-editing policy: a single selected text element is,
 * by definition, the element being edited (there is no separate
 * "selected-not-editing" state for text). Anything else resolves to "".
 *
 * This is the value the surface writes into the canvas store's
 * `editingElementId`, which the renderer's `TextElementOperate` reads to swap
 * its dashed select frame for a clean solid editing frame.
 */
export function resolveEditingElementId(
  activeElementIdList: readonly string[],
  elements: readonly PPTElement[],
): string {
  const el = resolveSelectedElement(activeElementIdList, elements);
  return el?.type === 'text' ? el.id : '';
}
