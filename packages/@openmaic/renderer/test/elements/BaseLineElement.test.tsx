// @vitest-environment jsdom
import { render } from '@testing-library/react';
import type { PPTLineElement } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';

import { BaseLineElement } from '../../src/elements/line/BaseLineElement';

const line = {
  id: 'shared-line',
  type: 'line',
  left: 0,
  top: 0,
  start: [0, 0],
  end: [120, 40],
  width: 4,
  style: 'solid',
  color: '#123456',
  points: ['arrow', 'arrow'],
} as PPTLineElement;

function markerReferences(svg: SVGSVGElement): string[] {
  const path = svg.querySelector(':scope > path');
  return ['marker-start', 'marker-end'].map((attribute) => {
    const reference = path?.getAttribute(attribute);
    expect(reference).toMatch(/^url\(#.+\)$/);
    return reference!.slice(5, -1);
  });
}

describe('BaseLineElement marker ids', () => {
  it('keeps marker references local to each render instance and stable while scaling', () => {
    const { container, rerender } = render(
      <div style={{ transform: 'scale(1)' }}>
        <BaseLineElement elementInfo={line} animate={false} />
        <BaseLineElement elementInfo={line} animate={false} />
      </div>,
    );

    const before = Array.from(container.querySelectorAll('svg')).map((svg) => {
      const references = markerReferences(svg);
      const ownMarkerIds = Array.from(svg.querySelectorAll('marker'), (marker) => marker.id);

      expect(references).toEqual(ownMarkerIds);
      return references;
    });

    expect(new Set(before.flat()).size).toBe(4);

    rerender(
      <div style={{ transform: 'scale(1.75)' }}>
        <BaseLineElement elementInfo={line} animate={false} />
        <BaseLineElement elementInfo={line} animate={false} />
      </div>,
    );

    const after = Array.from(container.querySelectorAll('svg')).map(markerReferences);
    expect(after).toEqual(before);
    expect((container.firstElementChild as HTMLElement).style.transform).toBe('scale(1.75)');
  });
});
