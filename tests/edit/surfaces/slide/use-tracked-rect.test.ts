// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTrackedRect } from '@/components/edit/surfaces/slide/use-tracked-rect';

let scheduledFrame: FrameRequestCallback | undefined;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe({ elementId }: { readonly elementId: string }) {
  const rect = useTrackedRect(elementId);
  return createElement(
    'output',
    { 'data-testid': 'rect' },
    rect ? `${rect.left},${rect.top},${rect.width},${rect.height}` : 'none',
  );
}

describe('useTrackedRect', () => {
  beforeEach(() => {
    scheduledFrame = undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      scheduledFrame = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('measures the renderer element-content root for an anchored image toolbar', () => {
    const wrapper = document.createElement('div');
    wrapper.id = 'editable-element-image-1';
    const content = document.createElement('div');
    content.className = 'element-content';
    content.getBoundingClientRect = () =>
      ({ left: 120, top: 80, width: 240, height: 160 }) as DOMRect;
    wrapper.append(content);
    document.body.append(wrapper);

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(createElement(Probe, { elementId: 'image-1' })));
    act(() => scheduledFrame?.(0));

    expect(container.querySelector('[data-testid="rect"]')?.textContent).toBe('120,80,240,160');
    act(() => root.unmount());
  });
});
