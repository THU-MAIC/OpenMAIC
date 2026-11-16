// @vitest-environment jsdom
/**
 * The first-run tour is a modal of its own (it holds the focus in its card and
 * takes Esc, ←/→ and Tab), and it sits above the app's dialogs. A modal dialog
 * opened while it plays (the access-code gate on a gated deployment, a
 * confirmation) must get its focus and keys: the tour steps aside until it
 * closes, then takes the focus back.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { WorkspaceTour, type TourEnd } from '@/components/workbench/workspace/WorkspaceTour';
import type { TourStep } from '@/components/workbench/workspace/tour-steps';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STEPS: TourStep[] = [
  { id: 'welcome', view: 'home', target: null },
  { id: 'compose', target: null },
];

let host: HTMLDivElement;
let root: Root;
const onEnd = vi.fn<(how: TourEnd) => void>();

/** A few animation frames: the tour notices dialogs on its per-frame tick. */
async function frames(n = 3) {
  for (let i = 0; i < n; i += 1) {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
  }
}

function openDialog(): { dialog: HTMLDivElement; input: HTMLInputElement } {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const input = document.createElement('input');
  dialog.appendChild(input);
  document.body.appendChild(dialog);
  return { dialog, input };
}

const tour = () => document.querySelector<HTMLElement>('[data-testid="workspace-tour"]')!;
const next = () => document.querySelector<HTMLElement>('[data-testid="workspace-tour-next"]')!;

beforeEach(async () => {
  host = document.createElement('div');
  host.className = 'ws-root';
  document.body.appendChild(host);
  onEnd.mockClear();
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(WorkspaceTour, {
        steps: STEPS,
        onNavigate: () => {},
        onEnd,
        onSendExample: () => {},
      }),
    );
  });
  await frames();
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

it('holds the focus in its card while nothing else is open', async () => {
  expect(document.activeElement).toBe(next());
  const outside = document.createElement('input');
  document.body.appendChild(outside);
  await act(async () => outside.focus());
  expect(document.activeElement).toBe(next());
});

it('lets a modal dialog opened over it keep the focus and the keys', async () => {
  const { input } = openDialog();
  await frames();
  expect(tour().dataset.yielded).toBe('true');

  await act(async () => input.focus());
  expect(document.activeElement).toBe(input);

  // Esc and the arrows are the dialog's: the tour neither ends nor moves.
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(onEnd).not.toHaveBeenCalled();
  expect(tour().dataset.step).toBe('welcome');
  expect(document.activeElement).toBe(input);
});

it('yields from the first keystroke, before its tick has seen the dialog', async () => {
  const { input } = openDialog();
  input.focus();
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(onEnd).not.toHaveBeenCalled();
});

it('takes the focus back once the dialog closes', async () => {
  const { dialog, input } = openDialog();
  await frames();
  await act(async () => input.focus());
  dialog.remove();
  await frames();
  expect(tour().dataset.yielded).toBeUndefined();
  expect(document.activeElement).toBe(next());
});
