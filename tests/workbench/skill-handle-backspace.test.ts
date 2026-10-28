import type { KeyboardEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The composer's Backspace hook, as both composers (the conversation's and the
 * launch panel's) wire it: a completed handle goes as one unit, a handle still
 * being typed loses one character (the hook declines and the browser's default
 * applies), and IME composition and selections are never touched.
 */

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
}));

import { useSkillHandleBackspace } from '@/components/workbench/use-skill-handle-backspace';

const INSTALLED = ['deep-research', 'stage-design'];

function keyEvent(
  value: string,
  options: {
    key?: string;
    selectionStart?: number;
    selectionEnd?: number;
    isComposing?: boolean;
    keyCode?: number;
  } = {},
) {
  const selectionStart = options.selectionStart ?? value.length;
  const preventDefault = vi.fn();
  const event = {
    key: options.key ?? 'Backspace',
    keyCode: options.keyCode ?? 8,
    nativeEvent: { isComposing: options.isComposing ?? false },
    currentTarget: {
      value,
      selectionStart,
      selectionEnd: options.selectionEnd ?? selectionStart,
    },
    preventDefault,
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
  return { event, preventDefault };
}

describe('useSkillHandleBackspace', () => {
  const setDraft = vi.fn();
  const onCaret = vi.fn();
  let handle: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;

  beforeEach(() => {
    setDraft.mockReset();
    onCaret.mockReset();
    handle = useSkillHandleBackspace(setDraft, onCaret, INSTALLED);
  });

  it('leaves a partial handle to the browser, which deletes one character', () => {
    const { event, preventDefault } = keyEvent('/deep-res');
    expect(handle(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(setDraft).not.toHaveBeenCalled();
  });

  it('deletes a completed handle as one unit', () => {
    const { event, preventDefault } = keyEvent('Plan a lesson /deep-research ');
    expect(handle(event)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(setDraft).toHaveBeenCalledWith('Plan a lesson ');
    expect(onCaret).toHaveBeenCalledWith('Plan a lesson '.length);
  });

  it('leaves a caret in the middle of a handle alone', () => {
    const { event, preventDefault } = keyEvent('/deep-research ', {
      selectionStart: '/deep-res'.length,
    });
    expect(handle(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('never acts during IME composition', () => {
    for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
      const { event, preventDefault } = keyEvent('/deep-research ', ime);
      expect(handle(event)).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(setDraft).not.toHaveBeenCalled();
  });

  it('leaves a selection to the browser', () => {
    const { event, preventDefault } = keyEvent('/deep-research ', {
      selectionStart: 0,
      selectionEnd: '/deep-research '.length,
    });
    expect(handle(event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('ignores other keys', () => {
    const { event } = keyEvent('/deep-research ', { key: 'Delete' });
    expect(handle(event)).toBe(false);
  });
});
