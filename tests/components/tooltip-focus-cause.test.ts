// @vitest-environment jsdom

/**
 * A tooltip opens on keyboard navigation focus, not on focus a script moves
 * after keyboard input (a dialog's auto-focus after Enter, focus handed back
 * after Escape). Driven through the real Radix tooltip.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  focusOpensTooltip,
} from '@/components/ui/tooltip';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Radix measures the content with ResizeObserver, which jsdom lacks.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        Tooltip,
        null,
        createElement(TooltipTrigger, { id: 'trigger' }, 'Icon'),
        createElement(TooltipContent, null, 'Tooltip text'),
      ),
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function trigger() {
  return container.querySelector<HTMLButtonElement>('#trigger')!;
}

function tooltipOpen() {
  return document.querySelector('[role="tooltip"]') !== null;
}

async function press(key: string) {
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

async function focusTrigger() {
  await act(async () => trigger().focus());
}

describe('tooltip focus cause', () => {
  it('opens when Tab moves focus to the trigger', async () => {
    await press('Tab');
    await focusTrigger();
    expect(tooltipOpen()).toBe(true);
  });

  it('stays closed for focus a script moves after Enter (dialog auto-focus)', async () => {
    await press('Enter');
    await focusTrigger();
    expect(tooltipOpen()).toBe(false);
  });

  it('stays closed for focus handed back after Escape (dialog close)', async () => {
    await press('Escape');
    await focusTrigger();
    expect(tooltipOpen()).toBe(false);
  });

  it('a lone modifier does not change the cause (Shift before Shift+Tab)', async () => {
    await press('Enter');
    await press('Shift');
    await press('Tab');
    await focusTrigger();
    expect(tooltipOpen()).toBe(true);
  });

  it('stays closed for focus after a pointer press', async () => {
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    await focusTrigger();
    expect(tooltipOpen()).toBe(false);
  });
});

describe('focusOpensTooltip', () => {
  it('ignores a :focus-visible the browser kept across keyboard-triggered script focus', () => {
    // Browsers keep :focus-visible when a script moves focus after a key press,
    // so it matches for a dialog's auto-focus after Enter or its focus return
    // after Escape. The recorded cause decides instead.
    const visible = { matches: () => true } as unknown as Element;
    expect(focusOpensTooltip(visible, 'other-key')).toBe(false);
    expect(focusOpensTooltip(visible, 'pointer')).toBe(false);
    expect(focusOpensTooltip(visible, 'navigation-key')).toBe(true);
  });

  it('falls back to :focus-visible before any input, and opens when unsupported', () => {
    const el = { matches: () => false } as unknown as Element;
    expect(focusOpensTooltip(el, 'none')).toBe(false);
    const unsupported = {
      matches: () => {
        throw new Error('unsupported selector');
      },
    } as unknown as Element;
    expect(focusOpensTooltip(unsupported, 'none')).toBe(true);
    expect(focusOpensTooltip(el, 'navigation-key')).toBe(true);
  });
});
