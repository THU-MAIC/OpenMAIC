'use client';

import { AnchoredBar } from './AnchoredBar';
import type { TextFormatToolbarProps } from '@openmaic/editor/ui';
import type { TextCommandPayload } from '@/lib/prosemirror/active-editor-registry';
import { ConnectedTextFormatBar, TextFormatBar } from './text-format-bar';
import { DeleteButton } from './DeleteButton';
import { ZOrderButtons } from './ZOrderButtons';

interface AnchoredTextBarProps {
  /** The text element being edited, or "" when no text element is being edited. */
  readonly editingElementId: string;
  readonly toolbar?: TextFormatToolbarProps;
}

const Separator = () => <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-800" />;

/**
 * The selection-anchored bar for a text element — the format controls, z-order
 * (to-front/to-back), and delete, hugging the element being edited. See
 * AnchoredBar for the shell.
 */
export function AnchoredTextBar({ editingElementId, toolbar }: AnchoredTextBarProps) {
  return (
    <AnchoredBar elementId={editingElementId}>
      <div
        className="flex items-center gap-1"
        role={toolbar ? 'toolbar' : undefined}
        aria-label={toolbar?.labels?.toolbar}
      >
        {toolbar ? (
          <TextFormatBar
            elementId={editingElementId}
            attrs={toolbar.format}
            onCommand={(payload) => runToolbarCommand(toolbar, payload)}
          />
        ) : (
          <ConnectedTextFormatBar elementId={editingElementId} />
        )}
        {(!toolbar || (toolbar.onBringToFront && toolbar.onSendToBack)) && (
          <>
            <Separator />
            <ZOrderButtons
              elementId={editingElementId}
              onBringToFront={toolbar?.onBringToFront}
              onSendToBack={toolbar?.onSendToBack}
            />
          </>
        )}
        {(!toolbar || toolbar.onDelete) && (
          <>
            <Separator />
            <DeleteButton elementId={editingElementId} onDelete={toolbar?.onDelete} />
          </>
        )}
      </div>
    </AnchoredBar>
  );
}

function runToolbarCommand(
  { onCommand }: TextFormatToolbarProps,
  { command, value }: TextCommandPayload,
) {
  switch (command) {
    case 'align-left':
    case 'align-center':
    case 'align-right':
      return onCommand({ command: 'align', value: command.slice('align-'.length) });
    case 'fontname':
    case 'fontsize':
    case 'forecolor':
      if (value !== undefined) onCommand({ command, value });
      return;
    default:
      return onCommand({ command });
  }
}
