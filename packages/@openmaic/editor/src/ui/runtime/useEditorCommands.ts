import { useMemo } from 'react';
import type { SlideContent } from '@openmaic/dsl';
import type { EditorTransaction } from '../../core';
import {
  createCanvasCommands,
  createClipboardPasteState,
  createElementClipboard,
  useCanvasShortcuts,
} from '../../react';
import type { Selection } from '../../react/types';
import type { CanvasContextMenuOptions } from '../types';
import type { EditorLabels } from '../labels';
import type { ResolvedEditorHostCapabilities } from '../host';

interface EditorCommandsOptions {
  readonly content: SlideContent;
  readonly selection: Selection;
  readonly hiddenElementIds?: readonly string[];
  readonly host: ResolvedEditorHostCapabilities;
  readonly labels: EditorLabels;
  readonly editorFocused: boolean;
  readonly onTransaction: (transaction: EditorTransaction) => void;
  readonly onSelectionChange: (selection: Selection) => void;
  readonly onClearCreation: () => void;
}

export function useEditorCommands({
  content,
  selection,
  hiddenElementIds,
  host,
  labels,
  editorFocused,
  onTransaction,
  onSelectionChange,
  onClearCreation,
}: EditorCommandsOptions): CanvasContextMenuOptions {
  const clipboard = useMemo(() => createElementClipboard(), []);
  const clipboardPasteState = useMemo(() => createClipboardPasteState(), []);
  const commands = useMemo(
    () =>
      createCanvasCommands({
        content,
        selection,
        hiddenElementIds,
        onTransaction,
        onSelectionChange,
        createElementId: host.createElementId,
        clipboard,
        clipboardPasteState,
      }),
    [
      clipboard,
      clipboardPasteState,
      content,
      hiddenElementIds,
      host.createElementId,
      onSelectionChange,
      onTransaction,
      selection,
    ],
  );
  const shortcutCommands = useMemo(
    () => ({
      ...commands,
      clearSelection: () => {
        onClearCreation();
        commands.clearSelection();
      },
    }),
    [commands, onClearCreation],
  );
  useCanvasShortcuts(shortcutCommands, {
    enabled: host.shortcutsEnabled && !editorFocused,
  });

  return useMemo(
    () => ({
      labels: labels.contextMenu,
      onSelectAll: commands.selectAll,
      onCopy: commands.copySelection,
      onCut: commands.cutSelection,
      onPaste: commands.pasteElements,
      onUnlock: commands.unlockTarget,
      onLock: commands.lockSelection,
      onDelete: commands.deleteSelection,
      onToggleGroup: commands.toggleGroup,
      onReorder: commands.reorderTarget,
      onAlign: commands.alignSelection,
    }),
    [commands, labels.contextMenu],
  );
}
