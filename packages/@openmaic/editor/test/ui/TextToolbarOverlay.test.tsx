// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TextFormatState } from '../../src/react/text/types';
import { computeToolbarPosition, LineToolbarOverlay, TextToolbarOverlay } from '../../src/ui';
import type { PPTLineElement } from '@openmaic/dsl';

const format: TextFormatState = {
  bold: false,
  em: false,
  underline: false,
  strikethrough: false,
  superscript: false,
  subscript: false,
  code: false,
  color: '#000000',
  backcolor: '',
  fontsize: '20px',
  fontname: 'Arial',
  link: '',
  align: 'left',
  bulletList: false,
  orderedList: false,
  blockquote: false,
};

const observers: ResizeObserverMock[] = [];

class ResizeObserverMock {
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }

  unobserve() {}
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

function addTextAnchor(prefix = 'canvas-element-', elementId = 'text-1') {
  const wrapper = document.createElement('div');
  wrapper.id = prefix + elementId;
  const text = document.createElement('div');
  text.className = 'base-element-text';
  wrapper.appendChild(text);
  document.body.appendChild(wrapper);
  return { text, wrapper };
}

function addLineAnchor(prefix = 'canvas-element-', elementId = 'line-1') {
  const wrapper = document.createElement('div');
  wrapper.id = prefix + elementId;
  const line = document.createElement('div');
  line.className = 'base-element-line';
  wrapper.appendChild(line);
  document.body.appendChild(wrapper);
  return { line, wrapper };
}

const lineElement: PPTLineElement = {
  id: 'line-1',
  type: 'line',
  left: 0,
  top: 0,
  width: 2,
  start: [0, 0],
  end: [120, 80],
  style: 'solid',
  color: '#333333',
  points: ['', ''],
};

function renderOverlay() {
  return render(
    <TextToolbarOverlay
      elementId="text-1"
      elementIdPrefix="canvas-element-"
      format={format}
      onCommand={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  observers.length = 0;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('computeToolbarPosition', () => {
  it('centers a top toolbar above its anchor', () => {
    expect(
      computeToolbarPosition(
        { left: 200, top: 200, width: 100, height: 50 },
        { width: 300, height: 48 },
        { width: 1000, height: 700 },
        'top',
      ),
    ).toEqual({ left: 100, top: 144, side: 'top' });
  });

  it('flips a top toolbar below its anchor and clamps its left edge', () => {
    expect(
      computeToolbarPosition(
        { left: 4, top: 10, width: 100, height: 50 },
        { width: 300, height: 48 },
        { width: 320, height: 700 },
        'top',
      ),
    ).toEqual({ left: 12, top: 68, side: 'bottom' });
  });

  it('clamps a toolbar against the viewport right edge', () => {
    expect(
      computeToolbarPosition(
        { left: 930, top: 200, width: 100, height: 50 },
        { width: 300, height: 48 },
        { width: 1000, height: 700 },
        'top',
      ),
    ).toEqual({ left: 688, top: 144, side: 'top' });
  });

  it('flips an explicit bottom toolbar upward when it would overflow', () => {
    expect(
      computeToolbarPosition(
        { left: 200, top: 650, width: 100, height: 40 },
        { width: 300, height: 48 },
        { width: 1000, height: 700 },
        'bottom',
      ),
    ).toEqual({ left: 100, top: 594, side: 'top' });
  });
});

describe('TextToolbarOverlay', () => {
  it('portals the toolbar to the body and hides it when its anchor is removed', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { text, wrapper } = addTextAnchor();
    vi.spyOn(text, 'getBoundingClientRect').mockReturnValue(rect(200, 200, 100, 50));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute('data-toolbar-overlay') ? rect(0, 0, 300, 48) : new DOMRect();
    });

    renderOverlay();

    const toolbar = await screen.findByRole('toolbar');
    const overlay = toolbar.parentElement as HTMLDivElement;
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.dataset.side).toBe('top');
    expect(overlay.style.left).toBe('100px');
    expect(overlay.style.top).toBe('144px');

    wrapper.remove();
    act(() => window.dispatchEvent(new Event('resize')));

    await waitFor(() => expect(screen.queryByRole('toolbar')).toBeNull());
  });

  it('releases its observers, animation frame, and global listeners on unmount', () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 42),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { text } = addTextAnchor();
    vi.spyOn(text, 'getBoundingClientRect').mockReturnValue(rect(200, 200, 100, 50));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute('data-toolbar-overlay') ? rect(0, 0, 300, 48) : new DOMRect();
    });
    const windowRemove = vi.spyOn(window, 'removeEventListener');
    const documentRemove = vi.spyOn(document, 'removeEventListener');

    const { unmount } = renderOverlay();
    unmount();

    expect(observers).toHaveLength(2);
    expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(windowRemove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(windowRemove).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    expect(windowRemove).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(windowRemove).toHaveBeenCalledWith('pointercancel', expect.any(Function));
    expect(documentRemove).toHaveBeenCalledWith('scroll', expect.any(Function), true);
  });
});

describe('LineToolbarOverlay', () => {
  it('uses a line paint node as its toolbar anchor', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { line } = addLineAnchor();
    vi.spyOn(line, 'getBoundingClientRect').mockReturnValue(rect(200, 200, 120, 80));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute('data-toolbar-overlay') ? rect(0, 0, 300, 48) : new DOMRect();
    });

    render(
      <LineToolbarOverlay
        element={lineElement}
        elementIdPrefix="canvas-element-"
        onChange={vi.fn()}
      />,
    );

    const toolbar = await screen.findByRole('toolbar', { name: 'Line toolbar' });
    expect((toolbar.parentElement as HTMLElement).style.visibility).toBe('visible');
    expect((toolbar.parentElement as HTMLElement).style.left).toBe('110px');
  });
});
