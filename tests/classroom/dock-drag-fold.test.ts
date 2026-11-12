// @vitest-environment jsdom

/**
 * The classroom dock folds and unfolds live within one drag of its top edge, the
 * same gesture as the workspace rail's (`trackFoldableResize`), on the vertical axis.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { DockResizeHandle, useDockBox } from '@/components/classroom/dock-box';
import { DOCK_COLLAPSE_BELOW, DOCK_FOLDED_HEIGHT } from '@/lib/edit/dock-height';
import { useSettingsStore } from '@/lib/store/settings';
import {
  nextFolded,
  RESIZE_FOLD_HYSTERESIS,
  trackFoldableResize,
} from '@/lib/utils/foldable-resize';

// A move carries the held primary button: a move with none means the pointer
// was released where the window could not hear it.
function pointerEvent(type: string, init: MouseEventInit = {}) {
  const buttons = type === 'pointermove' ? 1 : 0;
  const event = new MouseEvent(type, { bubbles: true, button: 0, buttons, ...init });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

const at = (type: string, clientY: number) => pointerEvent(type, { clientX: 400, clientY });

describe('the fold state machine', () => {
  it('folds below the threshold and unfolds only past the hysteresis', () => {
    expect(nextFolded(false, 101, 100)).toBe(false);
    expect(nextFolded(false, 99, 100)).toBe(true);
    // In the band: whatever it is now, it stays.
    expect(nextFolded(true, 100, 100)).toBe(true);
    expect(nextFolded(true, 100 + RESIZE_FOLD_HYSTERESIS - 1, 100)).toBe(true);
    expect(nextFolded(false, 100 + RESIZE_FOLD_HYSTERESIS - 1, 100)).toBe(false);
    expect(nextFolded(true, 100 + RESIZE_FOLD_HYSTERESIS, 100)).toBe(false);
  });

  function track(folded = false, startSize = 192) {
    const calls = { preview: [] as number[], commit: [] as number[], events: [] as string[] };
    trackFoldableResize({
      pointerId: 1,
      clientX: 400,
      clientY: 500,
      axis: 'y',
      grow: -1,
      startSize,
      remembered: 192,
      folded,
      collapseBelow: 100,
      handlers: () => ({
        clamp: (h) => Math.min(480, Math.max(150, h)),
        onPreview: (h) => calls.preview.push(h),
        onCommit: (h) => calls.commit.push(h),
        onCollapse: () => calls.events.push('collapse'),
        onExpand: () => calls.events.push('expand'),
      }),
      onEnd: () => calls.events.push('end'),
    });
    return calls;
  }

  it('on the vertical axis: down shrinks, past the threshold folds, back up unfolds', () => {
    const calls = track();
    window.dispatchEvent(at('pointermove', 450)); // 242
    expect(calls.preview.at(-1)).toBe(242);
    window.dispatchEvent(at('pointermove', 560)); // 132: held at the minimum
    expect(calls.preview.at(-1)).toBe(150);
    window.dispatchEvent(at('pointermove', 600)); // 92: folds, height put back
    expect(calls.events).toEqual(['collapse']);
    expect(calls.preview.at(-1)).toBe(192);
    window.dispatchEvent(at('pointermove', 590)); // 102: inside the band, still folded
    window.dispatchEvent(at('pointermove', 599)); // 93
    window.dispatchEvent(at('pointermove', 592)); // 100
    expect(calls.events).toEqual(['collapse']);
    window.dispatchEvent(at('pointermove', 592 - RESIZE_FOLD_HYSTERESIS)); // 108: unfolds
    expect(calls.events).toEqual(['collapse', 'expand']);
    window.dispatchEvent(at('pointermove', 400)); // 292: follows the pointer
    window.dispatchEvent(at('pointerup', 400));
    expect(calls.preview.at(-1)).toBe(292);
    expect(calls.commit).toEqual([292]);
    expect(calls.events).toEqual(['collapse', 'expand', 'end']);
  });

  it('ends folded without committing anything', () => {
    const calls = track();
    window.dispatchEvent(at('pointermove', 700));
    window.dispatchEvent(at('pointerup', 700));
    expect(calls.events).toEqual(['collapse', 'end']);
    expect(calls.commit).toEqual([]);
  });

  it('starts folded and unfolds upward, following the pointer', () => {
    const calls = track(true, DOCK_FOLDED_HEIGHT);
    window.dispatchEvent(at('pointermove', 460)); // 73: still folded
    expect(calls.events).toEqual([]);
    window.dispatchEvent(at('pointermove', 300)); // 233
    window.dispatchEvent(at('pointerup', 300));
    expect(calls.events).toEqual(['expand', 'end']);
    expect(calls.commit).toEqual([233]);
  });

  it('a click does nothing, folded or not', () => {
    for (const folded of [false, true]) {
      const calls = track(folded, folded ? DOCK_FOLDED_HEIGHT : 192);
      window.dispatchEvent(at('pointermove', 501));
      window.dispatchEvent(at('pointerup', 501));
      expect(calls.events).toEqual(['end']);
      expect(calls.commit).toEqual([]);
    }
  });
});

describe('the classroom dock edge', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  const rects = HTMLElement.prototype.getBoundingClientRect;

  beforeAll(() => {
    Element.prototype.setPointerCapture = () => undefined;
  });

  beforeEach(() => {
    useSettingsStore.setState({ dockHeight: 192, dockCollapsed: false });
    // jsdom has no layout: an element is as tall as its inline height says.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const height = parseFloat(this.style.height) || 0;
      return { height, width: 0, top: 0, left: 0, right: 0, bottom: height } as DOMRect;
    };
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    HTMLElement.prototype.getBoundingClientRect = rects;
    vi.unstubAllGlobals();
    useSettingsStore.setState({ dockHeight: 192, dockCollapsed: false });
  });

  // The dock's markup, as the classroom renders it: the handle reads the ref only in
  // its event handlers, which the createElement form hides from the lint rule.
  /* eslint-disable react-hooks/refs */
  function Dock({ held = false }: { held?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const dock = useDockBox(ref, held);
    return createElement(
      'div',
      null,
      createElement(
        'div',
        null,
        createElement(
          'div',
          { ref, 'data-testid': 'dock', style: { height: dock.height } },
          dock.held
            ? null
            : createElement(DockResizeHandle, { dockRef: ref, folded: dock.collapsed }),
        ),
      ),
    );
  } /* eslint-enable react-hooks/refs */

  async function render(held = false) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(Dock, { held })));
    const dock = container.querySelector('[data-testid="dock"]') as HTMLElement;
    const edge = () => container?.querySelector('[data-testid="dock-resize"]') as HTMLElement;
    return { dock, edge };
  }

  it('folds mid-drag, keeps the remembered height, and unfolds on the same drag', async () => {
    const { dock, edge } = await render();
    const handle = edge();
    await act(async () => {
      handle.dispatchEvent(at('pointerdown', 500));
      window.dispatchEvent(at('pointermove', 540)); // 152
    });
    expect(dock.style.height).toBe('152px');
    expect(dock.style.marginTop).toBe('40px');
    await act(async () => {
      window.dispatchEvent(at('pointermove', 500 + 192 - DOCK_COLLAPSE_BELOW + 1));
    });
    // Folded before any release, to the fold button's state, and the same edge stays.
    expect(useSettingsStore.getState().dockCollapsed).toBe(true);
    expect(dock.style.height).toBe(`${DOCK_FOLDED_HEIGHT}px`);
    expect(dock.style.marginTop).toBe('');
    expect(edge()).toBe(handle);
    expect(handle.dataset.folded).toBe('true');
    await act(async () => {
      window.dispatchEvent(
        at('pointermove', 500 + 192 - DOCK_COLLAPSE_BELOW - RESIZE_FOLD_HYSTERESIS),
      );
    });
    expect(useSettingsStore.getState().dockCollapsed).toBe(false);
    // Unfolded at the remembered height, then held at the minimum under the pointer.
    expect(dock.style.height).toBe('150px');
    expect(dock.style.marginTop).toBe('42px');
    await act(async () => {
      window.dispatchEvent(at('pointermove', 440)); // 252
      window.dispatchEvent(at('pointerup', 440));
    });
    expect(useSettingsStore.getState().dockHeight).toBe(252);
    expect(dock.style.height).toBe('252px');
    expect(dock.style.marginTop).toBe('');
  });

  it('a drag that ends folded leaves the remembered height alone', async () => {
    const { edge } = await render();
    await act(async () => {
      edge().dispatchEvent(at('pointerdown', 500));
      window.dispatchEvent(at('pointermove', 700));
      window.dispatchEvent(at('pointerup', 700));
    });
    expect(useSettingsStore.getState()).toMatchObject({ dockCollapsed: true, dockHeight: 192 });
  });

  it('the folded dock’s edge unfolds upward; a click on it does nothing', async () => {
    useSettingsStore.setState({ dockCollapsed: true });
    const { dock, edge } = await render();
    await act(async () => {
      edge().dispatchEvent(at('pointerdown', 500));
      window.dispatchEvent(at('pointerup', 500));
    });
    expect(useSettingsStore.getState()).toMatchObject({ dockCollapsed: true, dockHeight: 192 });
    expect(dock.hasAttribute('data-dragging')).toBe(false);

    await act(async () => {
      edge().dispatchEvent(at('pointerdown', 500));
      window.dispatchEvent(at('pointermove', 300)); // 33 + 200 = 233
      window.dispatchEvent(at('pointerup', 300));
    });
    expect(useSettingsStore.getState()).toMatchObject({ dockCollapsed: false, dockHeight: 233 });
  });

  it('aborts a drag in flight as the edge unmounts, committing nothing', async () => {
    const { edge } = await render();
    await act(async () => {
      edge().dispatchEvent(at('pointerdown', 500));
      window.dispatchEvent(at('pointermove', 460)); // 232
    });
    await act(async () => root?.unmount());
    root = null;
    window.dispatchEvent(at('pointermove', 400));
    window.dispatchEvent(at('pointerup', 400));
    expect(useSettingsStore.getState()).toMatchObject({ dockCollapsed: false, dockHeight: 192 });
  });

  it('ends a drag released outside the window at the next buttonless move', async () => {
    const { dock, edge } = await render();
    await act(async () => {
      edge().dispatchEvent(at('pointerdown', 500));
      window.dispatchEvent(at('pointermove', 460)); // 232
      window.dispatchEvent(pointerEvent('pointermove', { clientX: 400, clientY: 300, buttons: 0 }));
    });
    expect(useSettingsStore.getState().dockHeight).toBe(232);
    expect(dock.hasAttribute('data-dragging')).toBe(false);
    await act(async () => {
      window.dispatchEvent(at('pointermove', 300));
      window.dispatchEvent(at('pointerup', 300));
    });
    expect(useSettingsStore.getState().dockHeight).toBe(232);
  });

  it('keeps the value it reports inside its range, folded or open', async () => {
    const { edge } = await render();
    const range = () => {
      const el = edge();
      return ['aria-valuemin', 'aria-valuenow', 'aria-valuemax'].map((name) =>
        Number(el.getAttribute(name)),
      );
    };
    for (const collapsed of [false, true]) {
      await act(async () => useSettingsStore.setState({ dockCollapsed: collapsed }));
      const [min, now, max] = range();
      expect(min).toBeLessThanOrEqual(now);
      expect(now).toBeLessThanOrEqual(max);
    }
    expect(range()[1]).toBe(DOCK_FOLDED_HEIGHT);
  });

  it('unfolds from the keyboard: ArrowUp on the folded edge', async () => {
    useSettingsStore.setState({ dockCollapsed: true });
    const { edge } = await render();
    const key = (name: string) =>
      edge().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    await act(async () => key('ArrowDown'));
    expect(useSettingsStore.getState()).toMatchObject({ dockCollapsed: true, dockHeight: 192 });
    await act(async () => key('ArrowUp'));
    // Unfolded to the remembered height, not grown by a step.
    expect(useSettingsStore.getState()).toMatchObject({ dockCollapsed: false, dockHeight: 192 });
    expect(edge().getAttribute('aria-valuenow')).toBe('192');
  });

  it('a dock the classroom holds folded has no edge to unfold it', async () => {
    const { edge } = await render(true);
    expect(edge()).toBeNull();
  });

  it('sets data-dragging once per drag, at its start and end, a fold included', async () => {
    const { dock, edge } = await render();
    const before: (string | null)[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) before.push(record.oldValue);
    });
    observer.observe(dock, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-dragging'],
    });
    await act(async () => {
      edge().dispatchEvent(at('pointerdown', 500));
      for (const y of [520, 560, 600, 650, 600, 520, 450, 400]) {
        window.dispatchEvent(at('pointermove', y));
      }
      window.dispatchEvent(at('pointerup', 400));
    });
    await Promise.resolve();
    observer.disconnect();
    expect(before).toEqual([null, 'true']);
    expect(dock.hasAttribute('data-dragging')).toBe(false);
  });
});

describe('the dock under reduced motion and at the end of a drag', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

  it('drops its height transition for reduced motion, in both modes', () => {
    for (const path of [
      'components/roundtable/index.tsx',
      'components/edit/EditDock/EditDock.tsx',
    ]) {
      expect(read(path)).toContain(
        'data-[dragging=true]:transition-none motion-reduce:transition-none',
      );
    }
  });

  it('hangs no entrance animation on the per-drag flag', () => {
    // An animation switched off while `data-dragging` is set replays when it clears.
    for (const path of [
      'components/roundtable/index.tsx',
      'components/edit/EditDock/EditDock.tsx',
    ]) {
      expect(read(path)).not.toMatch(/data-dragging=true\][^'"\s]*:animate-none/);
    }
  });
});
