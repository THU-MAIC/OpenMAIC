'use client';

import { AnchoredBar } from './AnchoredBar';
import { ConnectedTextFormatBar } from './text-format-bar';
import { DeleteButton } from './DeleteButton';
import { ZOrderButtons } from './ZOrderButtons';

interface AnchoredTextBarProps {
  /** The text element being edited, or "" when no text element is being edited. */
  readonly editingElementId: string;
}

const Separator = () => <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-800" />;

/**
 * The selection-anchored bar for a text element — the format controls, z-order
 * (to-front/to-back), and delete, hugging the element being edited. See
 * AnchoredBar for the shell.
 */
export function AnchoredTextBar({ editingElementId }: AnchoredTextBarProps) {
  return (
    <AnchoredBar elementId={editingElementId}>
      <div className="flex items-center gap-1">
        <ConnectedTextFormatBar elementId={editingElementId} />
        <Separator />
        <ZOrderButtons elementId={editingElementId} />
        <Separator />
        <DeleteButton elementId={editingElementId} />
      </div>
    </AnchoredBar>
  );
}
