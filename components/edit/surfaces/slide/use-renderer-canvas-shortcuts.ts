'use client';

import { useEffect } from 'react';
import type { RendererCanvasCommands } from './renderer-canvas-commands';

interface CanvasShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  target: unknown;
  preventDefault: () => void;
}

interface CanvasShortcutOptions {
  enabled?: boolean;
  pickActive?: boolean;
}

function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  };
  const tagName = element.tagName?.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true;
  if (element.isContentEditable) return true;
  return Boolean(element.closest?.('.ProseMirror, [contenteditable="true"]'));
}

export function handleRendererCanvasShortcut(
  event: CanvasShortcutEvent,
  commands: RendererCanvasCommands,
  options: CanvasShortcutOptions = {},
): boolean {
  if (
    options.enabled === false ||
    options.pickActive ||
    event.repeat ||
    isEditableTarget(event.target)
  ) {
    return false;
  }

  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  let command: (() => void) | undefined;

  if (event.key === 'Delete' || event.key === 'Backspace') command = commands.deleteSelection;
  else if (event.key === 'Escape') command = commands.clearSelection;
  else if (mod && !event.altKey && key === 'a') command = commands.selectAll;
  else if (mod && !event.altKey && key === 'l') command = commands.lockSelection;
  else if (mod && !event.altKey && key === 'g') command = commands.toggleGroup;

  if (!command) return false;
  event.preventDefault();
  command();
  return true;
}

export function useRendererCanvasShortcuts(
  commands: RendererCanvasCommands,
  options: CanvasShortcutOptions = {},
): void {
  const { enabled = true, pickActive = false } = options;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      handleRendererCanvasShortcut(event, commands, { enabled, pickActive });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [commands, enabled, pickActive]);
}
