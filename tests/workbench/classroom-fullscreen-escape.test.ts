// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { shouldCollapseFullscreenOnEscape } from '@/lib/workbench/classroom-fullscreen';

function key(init: Partial<KeyboardEvent> & { target?: EventTarget | null } = {}) {
  return {
    key: 'Escape',
    defaultPrevented: false,
    isComposing: false,
    target: document.body,
    ...init,
  } as Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'isComposing' | 'target'>;
}

afterEach(() => document.body.replaceChildren());

describe('Escape in the full-screen classroom', () => {
  it('collapses on an Escape nobody handled', () => {
    expect(shouldCollapseFullscreenOnEscape(key())).toBe(true);
  });

  it('ignores other keys, handled Escapes and IME composition', () => {
    expect(shouldCollapseFullscreenOnEscape(key({ key: 'Enter' }))).toBe(false);
    expect(shouldCollapseFullscreenOnEscape(key({ defaultPrevented: true }))).toBe(false);
    expect(shouldCollapseFullscreenOnEscape(key({ isComposing: true }))).toBe(false);
  });

  it('leaves Escape to a text field, an editable element, a dialog or a menu', () => {
    const input = document.createElement('input');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    editable.append(inner);
    document.body.append(input, editable);
    expect(shouldCollapseFullscreenOnEscape(key({ target: input }))).toBe(false);
    expect(shouldCollapseFullscreenOnEscape(key({ target: inner }))).toBe(false);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.append(dialog);
    expect(shouldCollapseFullscreenOnEscape(key())).toBe(false);
  });
});
