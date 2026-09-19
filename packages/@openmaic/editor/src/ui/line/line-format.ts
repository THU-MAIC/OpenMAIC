import type { PPTLineElement } from '@openmaic/dsl';

export type LineKind = 'straight' | 'broken' | 'broken2' | 'curve' | 'cubic';

export interface LineKindPatch {
  readonly broken?: [number, number];
  readonly broken2?: [number, number];
  readonly curve?: [number, number];
  readonly cubic?: [[number, number], [number, number]];
}

export function getLineKind(element: PPTLineElement): LineKind {
  if (element.cubic) return 'cubic';
  if (element.curve) return 'curve';
  if (element.broken2) return 'broken2';
  if (element.broken) return 'broken';
  return 'straight';
}

export function toLineKindPatch(element: PPTLineElement, kind: LineKind): LineKindPatch {
  const midpoint: [number, number] = [
    (element.start[0] + element.end[0]) / 2,
    (element.start[1] + element.end[1]) / 2,
  ];

  return {
    broken: kind === 'broken' ? midpoint : undefined,
    broken2: kind === 'broken2' ? midpoint : undefined,
    curve: kind === 'curve' ? midpoint : undefined,
    cubic: kind === 'cubic' ? [midpoint, midpoint] : undefined,
  };
}
