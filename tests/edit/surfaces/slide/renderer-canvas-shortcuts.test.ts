import { describe, expect, it, vi } from 'vitest';
import type { RendererCanvasCommands } from '@/components/edit/surfaces/slide/renderer-canvas-commands';
import { handleRendererCanvasShortcut } from '@/components/edit/surfaces/slide/use-renderer-canvas-shortcuts';

function commands(): RendererCanvasCommands {
  return {
    clearSelection: vi.fn(),
    selectAll: vi.fn(),
    deleteSelection: vi.fn(),
    lockSelection: vi.fn(),
    unlockTarget: vi.fn(),
    toggleGroup: vi.fn(),
    reorderTarget: vi.fn(),
    alignSelection: vi.fn(),
  };
}

function keyEvent(
  key: string,
  options: { ctrlKey?: boolean; metaKey?: boolean; repeat?: boolean; target?: unknown } = {},
) {
  return {
    key,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    altKey: false,
    shiftKey: false,
    repeat: options.repeat ?? false,
    target: options.target ?? null,
    preventDefault: vi.fn(),
  };
}

describe('handleRendererCanvasShortcut', () => {
  it.each([
    ['Delete', 'deleteSelection'],
    ['Backspace', 'deleteSelection'],
    ['Escape', 'clearSelection'],
  ] as const)('maps %s to %s', (key, command) => {
    const c = commands();
    const event = keyEvent(key);

    expect(handleRendererCanvasShortcut(event, c)).toBe(true);

    expect(c[command]).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a', 'selectAll'],
    ['l', 'lockSelection'],
    ['g', 'toggleGroup'],
  ] as const)('maps Mod+%s to %s for Ctrl and Meta', (key, command) => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const c = commands();
      const event = keyEvent(key, modifier);
      expect(handleRendererCanvasShortcut(event, c)).toBe(true);
      expect(c[command]).toHaveBeenCalledTimes(1);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    }
  });

  it('ignores shortcuts while timeline pick mode is active', () => {
    const c = commands();
    const event = keyEvent('Delete');

    expect(handleRendererCanvasShortcut(event, c, { pickActive: true })).toBe(false);

    expect(c.deleteSelection).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores shortcuts when canvas hotkeys are disabled', () => {
    const c = commands();
    const event = keyEvent('Delete');

    expect(handleRendererCanvasShortcut(event, c, { enabled: false })).toBe(false);

    expect(c.deleteSelection).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
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
    const c = commands();
    const event = keyEvent('Delete', { target });

    expect(handleRendererCanvasShortcut(event, c)).toBe(false);
    expect(c.deleteSelection).not.toHaveBeenCalled();
  });

  it('does not treat an unmodified letter as a canvas shortcut', () => {
    const c = commands();
    const event = keyEvent('a');
    expect(handleRendererCanvasShortcut(event, c)).toBe(false);
    expect(c.selectAll).not.toHaveBeenCalled();
  });

  it('ignores keyboard auto-repeat so toggle commands run once per key press', () => {
    const c = commands();
    const event = keyEvent('g', { ctrlKey: true, repeat: true });

    expect(handleRendererCanvasShortcut(event, c)).toBe(false);
    expect(c.toggleGroup).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
