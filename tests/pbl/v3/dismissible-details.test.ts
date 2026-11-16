// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { DismissibleDetails } from '@/components/scene-renderers/pbl/v3/dismissible-details';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it('dismisses outside without losing drafts and restores focus only for Escape', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const outside = document.createElement('button');
  document.body.append(outside);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(
          DismissibleDetails,
          {},
          createElement('summary', {}, 'Progress'),
          createElement('input', { defaultValue: 'Draft' }),
        ),
      ),
    );
    const details = host.querySelector('details')!;
    const summary = host.querySelector('summary')!;
    const input = host.querySelector('input')!;
    details.open = true;
    input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(details.open).toBe(true);
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(details.open).toBe(false);
    expect(input.value).toBe('Draft');
    details.open = true;
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    details.open = true;
    outside.focus();
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(outside);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    outside.remove();
  }
});
