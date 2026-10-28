// @vitest-environment jsdom
/**
 * Backspace on a `/handle` in the workbench and launch composers.
 *
 * The hook is the only place IME composition and a selection are refused.
 * A handle that does not resolve is also refused, so the browser deletes one
 * character. A handle that names an installed skill is still one unit.
 */
import { act, createElement, type KeyboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSkillHandleBackspace } from '@/components/workbench/use-skill-handle-backspace';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Handler = (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(
  installedNames: readonly string[],
  setDraft: (next: string) => void,
  onCaret: (caret: number) => void,
) {
  let handler: Handler | undefined;
  const capture = (next: Handler) => {
    handler = next;
  };
  function Probe() {
    capture(useSkillHandleBackspace(setDraft, onCaret, installedNames));
    return null;
  }
  act(() => {
    root = createRoot(container!);
    root.render(createElement(Probe));
  });
  if (!handler) throw new Error('hook did not render');
  return handler;
}

function press(
  handler: Handler,
  value: string,
  init: {
    isComposing?: boolean;
    keyCode?: number;
    selectionStart?: number;
    selectionEnd?: number;
  } = {},
) {
  const selectionStart = init.selectionStart ?? value.length;
  const selectionEnd = init.selectionEnd ?? selectionStart;
  const preventDefault = vi.fn();
  const handled = handler({
    key: 'Backspace',
    keyCode: init.keyCode ?? 8,
    nativeEvent: { isComposing: init.isComposing ?? false },
    currentTarget: { value, selectionStart, selectionEnd },
    preventDefault,
  } as unknown as KeyboardEvent<HTMLTextAreaElement>);
  return { handled, preventDefault };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('skill-handle Backspace', () => {
  const installed = ['deep-research'];

  it('deletes one character while a handle is still being typed', () => {
    let draft = '/deep-res';
    const setDraft = vi.fn((next: string) => {
      draft = next;
    });
    const handler = mount(installed, setDraft, vi.fn());
    const { handled, preventDefault } = press(handler, draft);
    if (!handled) draft = draft.slice(0, -1);
    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
    expect(draft).toBe('/deep-re');
  });

  it('takes a completed handle that resolves to an installed skill', () => {
    let draft = '/deep-research ';
    const setDraft = vi.fn((next: string) => {
      draft = next;
    });
    const onCaret = vi.fn();
    const handler = mount(installed, setDraft, onCaret);
    const { handled, preventDefault } = press(handler, draft);
    if (!handled) draft = draft.slice(0, -1);
    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(draft).toBe('');
    expect(onCaret).toHaveBeenCalledWith(0);
  });

  it('leaves an IME composition alone, even on a resolving handle', () => {
    const draft = '/deep-research ';
    const setDraft = vi.fn();
    const handler = mount(installed, setDraft, vi.fn());
    const composing = press(handler, draft, { isComposing: true });
    expect(composing.handled).toBe(false);
    expect(composing.preventDefault).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
    const legacy = press(handler, draft, { keyCode: 229 });
    expect(legacy.handled).toBe(false);
    expect(legacy.preventDefault).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
  });

  it('leaves a selection to the browser, even on a resolving handle', () => {
    const draft = '/deep-research ';
    const setDraft = vi.fn();
    const handler = mount(installed, setDraft, vi.fn());
    const { handled, preventDefault } = press(handler, draft, {
      selectionStart: 0,
      selectionEnd: draft.length,
    });
    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
  });
});
