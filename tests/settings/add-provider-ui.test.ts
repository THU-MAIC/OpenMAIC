// @vitest-environment jsdom

/**
 * The add-provider dialog's name: it becomes the provider's id, so a name with
 * no Latin letter or digit (written only in Chinese, say) says why it cannot
 * be added instead of leaving the Add button disabled without a word.
 *
 * The i18n hook returns keys (with interpolated values appended).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? [key, ...Object.values(options)].join('|') : key,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));

import { AddProviderDialog } from '@/components/settings/add-provider-dialog';
import type { ApplyResult, ModelSettingsChange } from '@/lib/model-settings/client';

import { makeView } from '../model-settings/fixtures';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const NAME = 'settings.providerNamePlaceholder';
const BASE_URL = 'https://api.example.com/v1';
const NEEDS_LATIN = 'settings.serverConfig.providerNameNeedsLatin';

function mountDialog() {
  const view = makeView();
  const changes: ModelSettingsChange[] = [];
  const apply = vi.fn(async (change: ModelSettingsChange): Promise<ApplyResult> => {
    changes.push(change);
    return { ok: true, view };
  });
  const onAdded = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      createElement(AddProviderDialog, {
        open: true,
        onOpenChange: () => {},
        view,
        apply,
        onAdded,
      }),
    ),
  );
  return { apply, changes, onAdded };
}

function field(placeholder: string): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(
    `input[placeholder="${placeholder}"]`,
  );
  if (!found) throw new Error(`No field ${placeholder}`);
  return found;
}

/** Type into a React-controlled field. */
function type(element: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function addButton(): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes('settings.addProviderButton'),
  );
  if (!found) throw new Error('No Add button');
  return found;
}

describe('add-provider dialog name', () => {
  it('says why a name without a Latin letter or digit cannot be added', () => {
    const { apply } = mountDialog();
    type(field(BASE_URL), 'https://1.1.1.1/v1');
    type(field(NAME), '我的中转');
    expect(document.body.textContent).toContain(NEEDS_LATIN);
    expect(field(NAME).getAttribute('aria-invalid')).toBe('true');
    expect(addButton().disabled).toBe(true);
    act(() => addButton().click());
    expect(apply).not.toHaveBeenCalled();
  });

  it('shows the id a name with Latin letters is saved as, and adds it', async () => {
    const { changes, onAdded } = mountDialog();
    type(field(BASE_URL), 'https://1.1.1.1/v1');
    type(field(NAME), '我的 relay');
    expect(document.body.textContent).not.toContain(NEEDS_LATIN);
    expect(document.body.textContent).toContain('settings.serverConfig.providerIdHint|relay');
    expect(field(NAME).hasAttribute('aria-invalid')).toBe(false);
    expect(addButton().disabled).toBe(false);
    await act(async () => addButton().click());
    expect(changes).toEqual([
      { kind: 'provider', id: 'relay', preset: 'openai-compatible', baseUrl: 'https://1.1.1.1/v1' },
    ]);
    expect(onAdded).toHaveBeenCalledWith('relay');
  });

  it('says nothing while the name is empty', () => {
    mountDialog();
    type(field(NAME), '   ');
    expect(document.body.textContent).not.toContain(NEEDS_LATIN);
    expect(field(NAME).hasAttribute('aria-invalid')).toBe(false);
    expect(addButton().disabled).toBe(true);
  });
});
