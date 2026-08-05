export const EDITABLE_ELEMENT_ID_PREFIX = 'editable-element-';

export function editableElementDomId(elementId: string): string {
  return `${EDITABLE_ELEMENT_ID_PREFIX}${elementId}`;
}
