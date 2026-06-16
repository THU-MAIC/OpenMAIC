/**
 * Pure, dependency-free type guards for the slide object model.
 *
 * These narrow a `PPTElement` union member to its concrete variant by its
 * discriminant `type`. No runtime dependencies, no side effects.
 */
import type {
  PPTElement,
  PPTTextElement,
  PPTImageElement,
  PPTShapeElement,
  PPTLineElement,
  PPTChartElement,
  PPTTableElement,
  PPTLatexElement,
  PPTVideoElement,
  PPTAudioElement,
  PPTCodeElement,
} from './slides.js';

/** All valid `PPTElement["type"]` discriminants. */
export type PPTElementType = PPTElement['type'];

/** Frozen set of every supported element type, for cheap membership checks. */
export const PPT_ELEMENT_TYPES = [
  'text',
  'image',
  'shape',
  'line',
  'chart',
  'table',
  'latex',
  'video',
  'audio',
  'code',
] as const satisfies readonly PPTElementType[];

export function isPPTElementType(value: unknown): value is PPTElementType {
  return typeof value === 'string' && (PPT_ELEMENT_TYPES as readonly string[]).includes(value);
}

export function isTextElement(el: PPTElement): el is PPTTextElement {
  return el.type === 'text';
}

export function isImageElement(el: PPTElement): el is PPTImageElement {
  return el.type === 'image';
}

export function isShapeElement(el: PPTElement): el is PPTShapeElement {
  return el.type === 'shape';
}

export function isLineElement(el: PPTElement): el is PPTLineElement {
  return el.type === 'line';
}

export function isChartElement(el: PPTElement): el is PPTChartElement {
  return el.type === 'chart';
}

export function isTableElement(el: PPTElement): el is PPTTableElement {
  return el.type === 'table';
}

export function isLatexElement(el: PPTElement): el is PPTLatexElement {
  return el.type === 'latex';
}

export function isVideoElement(el: PPTElement): el is PPTVideoElement {
  return el.type === 'video';
}

export function isAudioElement(el: PPTElement): el is PPTAudioElement {
  return el.type === 'audio';
}

export function isCodeElement(el: PPTElement): el is PPTCodeElement {
  return el.type === 'code';
}
