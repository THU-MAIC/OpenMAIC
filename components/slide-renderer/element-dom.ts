/**
 * Element DOM contract — the one place that decides how a rendered slide
 * element is addressable from outside its own React tree.
 */
export const EDITABLE_ELEMENT_ID_PREFIX = 'editable-element-';
export const SCREEN_ELEMENT_ID_PREFIX = 'screen-element-';

/** Renderer-agnostic "this subtree paints element X" marker. */
export const MAIC_ELEMENT_ID_ATTRIBUTE = 'data-maic-element-id';

export function editableElementDomId(elementId: string): string {
  return `${EDITABLE_ELEMENT_ID_PREFIX}${elementId}`;
}

export function screenElementDomId(elementId: string): string {
  return `${SCREEN_ELEMENT_ID_PREFIX}${elementId}`;
}

/** Spread onto an element host so the attribute name is written once. */
export function maicElementIdAttributes(elementId: string): Record<string, string> {
  return { [MAIC_ELEMENT_ID_ATTRIBUTE]: elementId };
}
