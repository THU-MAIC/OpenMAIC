// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PPTTableElement } from '@openmaic/dsl';
import { StaticTable } from '../../../../renderer/src/elements/table/StaticTable';
import { SLIDE_RENDERER_STYLES } from '../../../../renderer/src/styles';
import { EDITOR_REACT_STYLES } from '../../../src/react/styles';
import { RendererTableEditor } from '../../../src/react/table/RendererTableEditor';

afterEach(cleanup);
it('keeps paragraph spacing in inactive and active table cells despite editor resets', () => {
  const table: PPTTableElement = {
    id: 'table',
    type: 'table',
    left: 0,
    top: 0,
    width: 200,
    height: 100,
    rotate: 0,
    colWidths: [1],
    cellMinHeight: 100,
    outline: { width: 1, color: '#000', style: 'solid' },
    data: [[{ id: 'cell', colspan: 1, rowspan: 1, text: '<p>First</p><p>Second</p>' }]],
  };
  const styles = (
    <>
      <style>{SLIDE_RENDERER_STYLES}</style>
      <style>{EDITOR_REACT_STYLES}</style>
    </>
  );
  const view = render(
    <>
      {styles}
      <StaticTable elementInfo={table} />
    </>,
  );
  const gap = () => getComputedStyle(view.container.querySelector('p + p')!).marginTop;
  const staticGap = gap();
  expect(staticGap).toBe('0.4em');
  view.rerender(
    <>
      {styles}
      <RendererTableEditor element={table} onChange={vi.fn()} />
    </>,
  );
  expect(gap()).toBe(staticGap);
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => document.body,
  });
  fireEvent.pointerDown(view.container.querySelector('td')!);
  expect(view.container.querySelector('.ProseMirror')).not.toBeNull();
  expect(gap()).toBe(staticGap);
});
