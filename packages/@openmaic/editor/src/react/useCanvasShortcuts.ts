'use client';

import { useEffect } from 'react';
import type { CanvasCommands } from './canvasCommands';

interface CanvasShortcutEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly repeat: boolean;
  readonly target: unknown;
  preventDefault: () => void;
}

export interface CanvasShortcutOptions {
  readonly enabled?: boolean;
  readonly pickActive?: boolean;
}

function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  };
  const tagName = element.tagName?.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    Boolean(element.isContentEditable) ||
    Boolean(element.closest?.('.ProseMirror, [contenteditable="true"]'))
  );
}

export function handleCanvasShortcut(
  event: CanvasShortcutEvent,
  commands: CanvasCommands,
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
  else if (mod && !event.altKey && key === 'c') command = () => void commands.copySelection();
  else if (mod && !event.altKey && key === 'x') command = () => void commands.cutSelection();
  else if (mod && !event.altKey && key === 'v') command = () => void commands.pasteElements();
  else if (mod && !event.altKey && key === 'l') command = commands.lockSelection;
  else if (mod && !event.altKey && key === 'g') command = commands.toggleGroup;
  if (!command) return false;
  event.preventDefault();
  command();
  return true;
}

export function useCanvasShortcuts(
  commands: CanvasCommands,
  options: CanvasShortcutOptions = {},
): void {
  const { enabled = true, pickActive = false } = options;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      handleCanvasShortcut(event, commands, { enabled, pickActive });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [commands, enabled, pickActive]);
}
