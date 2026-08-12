import { Fragment, type ReactNode } from 'react';
import { InsertToolbar } from '../insert/InsertToolbar';
import type { InsertToolbarOptions } from '../types';

interface EditorChromeProps {
  readonly insertToolbar?: InsertToolbarOptions;
  readonly onInsertToolbarRailSizeChange: (size: number) => void;
  readonly overlays: readonly ReactNode[];
}

export function EditorChrome({
  insertToolbar,
  onInsertToolbarRailSizeChange,
  overlays,
}: EditorChromeProps) {
  return (
    <>
      {insertToolbar ? (
        <InsertToolbar {...insertToolbar} onRailSizeChange={onInsertToolbarRailSizeChange} />
      ) : null}
      {overlays.map((overlay, index) => (
        <Fragment key={index}>{overlay}</Fragment>
      ))}
    </>
  );
}
