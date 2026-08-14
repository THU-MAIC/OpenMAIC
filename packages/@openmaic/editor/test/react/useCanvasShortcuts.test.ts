import { describe, expect, it, vi } from 'vitest';
import { handleCanvasShortcut, type CanvasCommands } from '../../src/react';

function commands(): CanvasCommands {
  return {
    clearSelection: vi.fn(),
    selectAll: vi.fn(),
    deleteSelection: vi.fn(),
    lockSelection: vi.fn(),
    copySelection: vi.fn(),
    cutSelection: vi.fn(),
    pasteElements: vi.fn(),
    unlockTarget: vi.fn(),
    toggleGroup: vi.fn(),
    reorderTarget: vi.fn(),
    alignSelection: vi.fn(),
  };
}

function keyEvent(
  key: string,
  options: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    repeat?: boolean;
    target?: unknown;
  } = {},
) {
  return {
    key,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    altKey: options.altKey ?? false,
    repeat: options.repeat ?? false,
    target: options.target ?? null,
    preventDefault: vi.fn(),
  };
}

describe('handleCanvasShortcut', () => {
  it.each([
    ['Delete', 'deleteSelection'],
    ['Backspace', 'deleteSelection'],
    ['Escape', 'clearSelection'],
  ] as const)('maps %s to %s', (key, command) => {
    const available = commands();
    const event = keyEvent(key);

    expect(handleCanvasShortcut(event, available)).toBe(true);
    expect(available[command]).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it.each([
    ['a', 'selectAll'],
    ['c', 'copySelection'],
    ['x', 'cutSelection'],
    ['v', 'pasteElements'],
    ['l', 'lockSelection'],
    ['g', 'toggleGroup'],
  ] as const)('maps Ctrl/Cmd+%s to %s', (key, command) => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const available = commands();
      const event = keyEvent(key, modifier);

      expect(handleCanvasShortcut(event, available)).toBe(true);
      expect(available[command]).toHaveBeenCalledOnce();
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
  });

  it.each([
    { tagName: 'INPUT' },
    { tagName: 'TEXTAREA' },
    { tagName: 'SELECT' },
    { tagName: 'DIV', isContentEditable: true },
    {
      tagName: 'DIV',
      closest: (selector: string) => (selector.includes('ProseMirror') ? {} : null),
    },
  ])('ignores editable targets', (target) => {
    const available = commands();
    const event = keyEvent('Delete', { target });

    expect(handleCanvasShortcut(event, available)).toBe(false);
    expect(available.deleteSelection).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    ['pick mode', { pickActive: true }],
    ['disabled shortcuts', { enabled: false }],
  ] as const)('ignores shortcuts during %s', (_label, options) => {
    const available = commands();
    const event = keyEvent('Delete');

    expect(handleCanvasShortcut(event, available, options)).toBe(false);
    expect(available.deleteSelection).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores unmodified letters, Alt combinations, and keyboard auto-repeat', () => {
    for (const event of [
      keyEvent('a'),
      keyEvent('g', { ctrlKey: true, altKey: true }),
      keyEvent('g', { ctrlKey: true, repeat: true }),
    ]) {
      const available = commands();
      expect(handleCanvasShortcut(event, available)).toBe(false);
      expect(available.toggleGroup).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  });
});
