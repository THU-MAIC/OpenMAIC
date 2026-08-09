import { nanoid } from 'nanoid';

/** Stable element id for editor-inserted elements. */
export function createElementId(prefix: string): string {
  return `${prefix}-${nanoid(8)}`;
}
