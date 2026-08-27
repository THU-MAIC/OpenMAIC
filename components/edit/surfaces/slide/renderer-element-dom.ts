export const EDITABLE_ELEMENT_ID_PREFIX = 'editable-element-';
export const MAIC_ELEMENT_ID_ATTRIBUTE = 'data-maic-element-id';

export function editableElementDomId(elementId: string): string {
  return `${EDITABLE_ELEMENT_ID_PREFIX}${elementId}`;
}

export function screenElementDomId(elementId: string): string {
  return `screen-element-${elementId}`;
}
