'use client';

import { AnchoredBar } from './AnchoredBar';
import { ConnectedTextFormatBar } from './text-format-bar';
import { DeleteButton } from './DeleteButton';

interface AnchoredTextBarProps {
  /** The text element being edited, or "" when no text element is being edited. */
  readonly editingElementId: string;
}

/**
 * The selection-anchored bar for a text element — the format controls plus
 * delete, hugging the element being edited. See AnchoredBar for the shell.
 */
export function AnchoredTextBar({ editingElementId }: AnchoredTextBarProps) {
  return (
    <AnchoredBar elementId={editingElementId}>
      <div className="flex items-center gap-1">
        <ConnectedTextFormatBar elementId={editingElementId} />
        <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
        <DeleteButton elementId={editingElementId} />
      </div>
    </AnchoredBar>
  );
}
