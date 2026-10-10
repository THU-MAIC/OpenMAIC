// @vitest-environment jsdom

import { act, createElement, useRef } from 'react';
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

describe('scoped material dragging', () => {
  it('auto-scrolls at the edge, expands after hover, and stops both on cancel', async () => {
    vi.useFakeTimers();
    const onMoveToFolder = vi.fn();
    const onHoverFolder = vi.fn();
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
    function Harness() {
      const scrollRef = useRef<HTMLDivElement>(null);
      const drag = useTreeDrag({ scrollRef, onMoveToFolder, onHoverFolder });
      return createElement(
        'div',
        // createElement forwards this ref to the DOM; it does not read .current.
        // eslint-disable-next-line react-hooks/refs
        { ref: scrollRef, 'data-testid': 'scroller' },
        createElement('div', { 'data-testid': 'source', ...drag.rowProps('material', 'm') }),
        createElement('div', { 'data-testid': 'target', ...drag.folderProps('f') }),
      );
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(createElement(Harness)));
    const scroller = container.querySelector<HTMLElement>('[data-testid="scroller"]')!;
    const source = container.querySelector<HTMLElement>('[data-testid="source"]')!;
    const target = container.querySelector<HTMLElement>('[data-testid="target"]')!;
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 200,
      left: 0,
      right: 200,
    } as DOMRect);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => target,
    });
    await act(async () => {
      source.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 190 }));
      frames.shift()!(performance.now() + 16);
    });
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(onHoverFolder).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(500));
    expect(onHoverFolder).toHaveBeenCalledWith('f');
    await act(async () => window.dispatchEvent(new PointerEvent('pointercancel')));
    expect(cancelFrame).toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(onHoverFolder).toHaveBeenCalledOnce();
    expect(onMoveToFolder).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not accept another mounted tree’s folder', async () => {
    const onMoveToFolder = vi.fn();
    function Harness() {
      const rail = useTreeDrag({ onMoveToFolder });
      const library = useTreeDrag({ onMoveToFolder });
      return createElement(
        'div',
        null,
        createElement('div', { 'data-testid': 'course', ...rail.rowProps('course', 'c') }),
        createElement('div', {
          'data-testid': 'folder',
          ...library.folderProps('material-folder'),
        }),
      );
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(createElement(Harness)));
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => container.querySelector('[data-testid="folder"]'),
    });
    await act(async () => {
      container
        .querySelector('[data-testid="course"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 }));
      window.dispatchEvent(new PointerEvent('pointerup'));
    });
    expect(onMoveToFolder).not.toHaveBeenCalled();
  });
});
