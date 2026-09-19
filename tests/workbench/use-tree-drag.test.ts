// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useTreeDrag } from '@/components/workbench/workspace/use-tree-drag';

const roots: Root[] = [];

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  if (!globalThis.PointerEvent) {
    vi.stubGlobal('PointerEvent', MouseEvent);
  }
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  Reflect.deleteProperty(document, 'elementFromPoint');
  vi.restoreAllMocks();
});

describe('useTreeDrag folder destinations', () => {
  it('decodes the unfiled container as an undefined folder destination', async () => {
    const onMoveToFolder = vi.fn();

    function Harness() {
      const drag = useTreeDrag({ onReorder: vi.fn(), onMoveToFolder });
      return createElement(
        'div',
        null,
        createElement('div', {
          'data-testid': 'course',
          ...drag.rowProps('course', 'course-1'),
        }),
        createElement('div', {
          'data-testid': 'unfiled',
          ...drag.folderProps(),
        }),
      );
    }

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(createElement(Harness)));

    const course = document.querySelector<HTMLElement>('[data-testid="course"]')!;
    const unfiled = document.querySelector<HTMLElement>('[data-testid="unfiled"]')!;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => unfiled),
    });

    await act(async () => {
      course.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 0,
          clientY: 0,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          clientX: 8,
          clientY: 0,
        }),
      );
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });

    expect(onMoveToFolder).toHaveBeenCalledOnce();
    expect(onMoveToFolder).toHaveBeenCalledWith('course-1', undefined);
  });

  it('reorders a row at the hit-tested insertion edge', async () => {
    const onReorder = vi.fn();

    function Harness() {
      const drag = useTreeDrag({ onReorder, onMoveToFolder: vi.fn() });
      return createElement(
        'div',
        null,
        createElement('div', {
          'data-testid': 'source',
          ...drag.rowProps('course', 'course-1'),
        }),
        createElement('div', {
          'data-testid': 'target',
          ...drag.rowProps('course', 'course-2'),
        }),
      );
    }

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(createElement(Harness)));

    const source = document.querySelector<HTMLElement>('[data-testid="source"]')!;
    const target = document.querySelector<HTMLElement>('[data-testid="target"]')!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: 20,
      height: 40,
    } as DOMRect);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => target),
    });

    await act(async () => {
      source.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 0,
          clientY: 0,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          clientX: 8,
          clientY: 55,
        }),
      );
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });

    expect(onReorder).toHaveBeenCalledWith('course', 'course-1', { after: 'course-2' });
  });
});
