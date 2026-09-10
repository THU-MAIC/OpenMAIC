// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FLOATING_LAYER_OWNER_ATTRIBUTE,
  FloatingLayerOwner,
  installFloatingLayerDismissListeners,
} from '@/components/ui/floating-layer-owner';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const OWNER_ID = 'rail-overflow-test-owner';
const roots: Root[] = [];
const listenerCleanups: Array<() => void> = [];

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterAll(() => vi.unstubAllGlobals());

function createDismissFixture() {
  const panel = document.createElement('div');
  const trigger = document.createElement('button');
  const portalContent = document.createElement('div');
  const portalControl = document.createElement('input');
  const outside = document.createElement('div');

  portalContent.setAttribute(FLOATING_LAYER_OWNER_ATTRIBUTE, OWNER_ID);
  portalContent.append(portalControl);
  document.body.append(panel, trigger, portalContent, outside);

  const close = vi.fn();
  listenerCleanups.push(
    installFloatingLayerDismissListeners({
      ownerId: OWNER_ID,
      roots: () => [panel, trigger],
      onDismiss: close,
    }),
  );

  return { close, panel, portalControl, outside };
}

afterEach(() => {
  for (const cleanup of listenerCleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

describe('workspace rail overflow portal ownership', () => {
  it('marks production Dialog and Dropdown portal content with the rail owner', async () => {
    const container = document.createElement('div');
    container.className = 'ws-root';
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        createElement(
          FloatingLayerOwner,
          { ownerId: OWNER_ID },
          createElement(
            Dialog,
            { open: true },
            createElement(
              DialogContent,
              { 'aria-describedby': undefined },
              createElement(DialogTitle, null, 'Feedback'),
              'feedback form',
            ),
          ),
          createElement(
            DropdownMenu,
            { open: true, modal: false },
            createElement(DropdownMenuTrigger, null, 'language'),
            createElement(
              DropdownMenuContent,
              null,
              createElement(DropdownMenuItem, null, 'English'),
              createElement(
                DropdownMenuSub,
                { open: true },
                createElement(DropdownMenuSubTrigger, null, 'More'),
                createElement(DropdownMenuSubContent, null, 'More languages'),
              ),
            ),
          ),
          createElement(
            Tooltip,
            { open: true },
            createElement(TooltipTrigger, null, 'community'),
            createElement(TooltipContent, null, 'Community'),
          ),
        ),
      );
    });

    expect(
      document
        .querySelector('[data-slot="dialog-content"]')
        ?.getAttribute(FLOATING_LAYER_OWNER_ATTRIBUTE),
    ).toBe(OWNER_ID);
    // The overlay belongs to the child dialog too: pressing it may close that
    // dialog, but must keep the parent rail overflow mounted for another choice.
    expect(
      document
        .querySelector('[data-slot="dialog-overlay"]')
        ?.getAttribute(FLOATING_LAYER_OWNER_ATTRIBUTE),
    ).toBe(OWNER_ID);
    expect(
      document
        .querySelector('[data-slot="dropdown-menu-content"]')
        ?.getAttribute(FLOATING_LAYER_OWNER_ATTRIBUTE),
    ).toBe(OWNER_ID);
    expect(
      document
        .querySelector('[data-slot="dropdown-menu-sub-content"]')
        ?.getAttribute(FLOATING_LAYER_OWNER_ATTRIBUTE),
    ).toBe(OWNER_ID);
    expect(
      document
        .querySelector('[data-slot="tooltip-content"]')
        ?.getAttribute(FLOATING_LAYER_OWNER_ATTRIBUTE),
    ).toBe(OWNER_ID);
  });

  it('keeps the rail overflow mounted through a portalled control click', () => {
    const { close, portalControl } = createDismissFixture();

    portalControl.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    portalControl.click();

    expect(close).not.toHaveBeenCalled();
  });

  it('does not dismiss when a portalled layer or the first-level panel scrolls', () => {
    const { close, panel, portalControl } = createDismissFixture();

    portalControl.dispatchEvent(new Event('scroll', { composed: true }));
    panel.dispatchEvent(new Event('scroll', { composed: true }));

    expect(close).not.toHaveBeenCalled();
  });

  it('still dismisses for a true outside pointer press and outside scroll', () => {
    const { close, outside } = createDismissFixture();

    outside.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    outside.dispatchEvent(new Event('scroll', { composed: true }));

    expect(close).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenNthCalledWith(1, false);
    expect(close).toHaveBeenNthCalledWith(2, false);
  });

  it('keeps the parent open for a child-handled Escape, then closes on an unhandled Escape', () => {
    const { close } = createDismissFixture();
    const childHandledEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    childHandledEscape.preventDefault();

    window.dispatchEvent(childHandledEscape);
    expect(close).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(true);
  });

  it('dismisses when resize invalidates the saved anchor', () => {
    const { close } = createDismissFixture();

    window.dispatchEvent(new Event('resize'));

    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(false);
  });
});
