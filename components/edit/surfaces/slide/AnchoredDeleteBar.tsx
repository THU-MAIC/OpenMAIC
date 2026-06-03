'use client';

import { AnchoredBar } from './AnchoredBar';
import { DeleteButton } from './DeleteButton';

interface AnchoredDeleteBarProps {
  /** The selected non-text element, or "" when none is selected. */
  readonly elementId: string;
}

/**
 * The selection-anchored bar for non-text elements — image, shape, line,
 * table, chart, … They have no format controls, so it carries just the delete
 * action. Hugs the selected element — see AnchoredBar.
 */
export function AnchoredDeleteBar({ elementId }: AnchoredDeleteBarProps) {
  return (
    <AnchoredBar elementId={elementId}>
      <DeleteButton elementId={elementId} />
    </AnchoredBar>
  );
}
